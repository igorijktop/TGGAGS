import { promises as fsp } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import picomatch from 'picomatch'
import type { ContextItem, ContextSnapshot, EditorContext, ImageData, Mention, Session } from '../../shared/ai'
import type { AgentConfig, Settings } from '../../shared/settings'
import { isImagePath, mimeForPath } from '../../shared/languages'
import { readTextFile } from '../services/fsapi'
import { walkFiles, fileIndex } from '../services/fileindex'
import { run } from '../services/proc'
import { uid } from '../services/storage'
import { httpFetch } from './providers/http'
import { htmlToMarkdown, extractTitle } from './tools/html'

// ───────────────────────── token estimation ─────────────────────────

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0, cyr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) cjk++
    else if (c >= 0x400 && c <= 0x4ff) cyr++
  }
  const rest = text.length - cjk - cyr
  return Math.ceil(rest / 3.6 + cjk * 1.1 + cyr / 2.2)
}

export const IMAGE_TOKENS = 1100

/** Head + tail truncation that keeps the beginning and end of a long text. */
export function truncateTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }
  const maxChars = Math.max(200, Math.floor(maxTokens * 3.4))
  const head = Math.floor(maxChars * 0.7), tail = maxChars - head
  const cut = text.length - maxChars
  return { text: `${text.slice(0, head)}\n\n… [${cut} characters omitted to fit the context budget] …\n\n${text.slice(text.length - tail)}`, truncated: true }
}

// ───────────────────────── secret redaction ─────────────────────────

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\bsk-(?:proj-|live-|or-v1-)?[A-Za-z0-9_-]{24,}\b/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED STRIPE KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=]{16,})(["']?)/gi, '$1[REDACTED]$3']
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

// ───────────────────────── helpers ─────────────────────────

const STOP = new Set('the and for with that this from have what when where which how why can you your our are was were will would should could into onto about make please file files code add fix use using use need want let get set run not but all any one two new old try also then than just like some more'.split(' '))

function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []
  return [...new Set(words.filter(w => !STOP.has(w)))].slice(0, 12)
}

function matchesAny(patterns: string[], rel: string): boolean {
  if (!patterns.length) return false
  const m = picomatch(patterns, { dot: true })
  return m(rel)
}

async function fetchPageText(url: string, maxChars: number): Promise<{ title: string; text: string }> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 20_000)
  try {
    const res = await httpFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 TGGAGS-IDE', accept: 'text/html,text/plain,application/json' }, signal: ac.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.text()
    const type = res.headers.get('content-type') ?? ''
    const html = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw)
    return { title: html ? extractTitle(raw) : url, text: (html ? htmlToMarkdown(raw, res.url) : raw).slice(0, maxChars) }
  } finally { clearTimeout(t) }
}

export interface BuildContextInput {
  session: Session
  root: string | null
  settings: Settings
  agent: AgentConfig
  userText: string
  mentions: Mention[]
  editor?: EditorContext
  window: number
  systemTokens: number
  historyTokens: number
  reserveOutput: number
  ratio: number
}

export interface BuiltContext { text: string; images: ImageData[]; snapshot: ContextSnapshot; items: ContextItem[] }

function mkItem(p: Partial<ContextItem> & Pick<ContextItem, 'kind' | 'label'>): ContextItem {
  return { id: uid('ctx-'), tokens: 0, enabled: true, pinned: false, priority: 3, auto: false, ...p }
}

function relPath(root: string | null, abs: string): string {
  return root ? relative(root, abs).split(sep).join('/') || abs : abs
}

async function treeOf(dir: string, maxEntries = 300): Promise<string> {
  const files = await walkFiles(dir)
  const lines = files.slice(0, maxEntries)
  return lines.join('\n') + (files.length > maxEntries ? `\n… (${files.length - maxEntries} more files)` : '')
}

async function resolveItem(item: ContextItem, root: string | null, s: Settings, signal?: AbortSignal): Promise<{ body: string; image?: ImageData; truncated?: boolean } | null> {
  const excl = s.context.excludePatterns
  const maxTok = s.context.maxItemTokens
  void signal
  switch (item.kind) {
    case 'file': {
      if (!item.path) return null
      const rel = relPath(root, item.path)
      if (matchesAny(excl, rel) && item.auto) return null
      if (isImagePath(item.path) && !/\.svg$/i.test(item.path)) {
        const buf = await fsp.readFile(item.path)
        if (buf.length > 6 * 1024 * 1024) return null
        return { body: '', image: { mime: mimeForPath(item.path), data: buf.toString('base64'), name: basename(item.path) } }
      }
      const r = await readTextFile(item.path)
      if (r.kind !== 'text') return { body: `(${rel}: ${r.kind === 'binary' ? 'binary file' : 'too large'} – not included)` }
      const t = truncateTokens(s.context.redactSecrets ? redactSecrets(r.content) : r.content, Math.min(maxTok, s.context.maxFileTokens))
      return { body: `<file path="${rel}">\n${t.text}\n</file>`, truncated: t.truncated }
    }
    case 'folder': {
      if (!item.path) return null
      const tree = await treeOf(item.path)
      return { body: `<folder path="${relPath(root, item.path) || '.'}">\n${tree}\n</folder>` }
    }
    case 'selection': {
      const rel = item.path ? relPath(root, item.path) : 'selection'
      const rng = item.range ? ` lines="${item.range.startLine}-${item.range.endLine}"` : ''
      const t = truncateTokens(s.context.redactSecrets ? redactSecrets(item.content ?? '') : item.content ?? '', maxTok)
      return { body: `<selection path="${rel}"${rng}>\n${t.text}\n</selection>`, truncated: t.truncated }
    }
    case 'image':
      return item.image ? { body: '', image: item.image } : null
    default: {
      const tag = ({ diff: 'git_diff', terminal: 'terminal_output', diagnostics: 'diagnostics', url: 'web_page', note: 'note', tabs: 'open_tabs', instructions: 'instructions', memory: 'memory', skill: 'skill' } as Record<string, string>)[item.kind] ?? 'context'
      const t = truncateTokens(s.context.redactSecrets ? redactSecrets(item.content ?? '') : item.content ?? '', maxTok)
      const attr = item.kind === 'url' ? ` url="${item.path ?? ''}"` : ''
      return { body: `<${tag}${attr}>\n${t.text}\n</${tag}>`, truncated: t.truncated }
    }
  }
}

async function retrieve(root: string, text: string, exclude: string[], limit = 3): Promise<string[]> {
  const kws = keywords(text)
  if (kws.length < 2) return []
  const all = await fileIndex.list(root, 60_000)
  const scored: { rel: string; score: number }[] = []
  for (const rel of all.slice(0, 40_000)) {
    if (matchesAny(exclude, rel)) continue
    const l = rel.toLowerCase()
    const base = l.split('/').pop() ?? l
    let sc = 0
    for (const k of kws) { if (base.includes(k)) sc += 3; else if (l.includes(k)) sc += 1 }
    if (sc > 0) scored.push({ rel, score: sc })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 30)
  const ranked: { rel: string; score: number }[] = []
  for (const c of top) {
    try {
      const st = await fsp.stat(join(root, c.rel))
      if (st.size > 120_000) { ranked.push(c); continue }
      const content = (await fsp.readFile(join(root, c.rel), 'utf8')).toLowerCase()
      let tf = 0
      for (const k of kws) { let i = -1, n = 0; while ((i = content.indexOf(k, i + 1)) >= 0 && n < 20) n++; tf += Math.min(n, 8) }
      ranked.push({ rel: c.rel, score: c.score + tf * 0.5 })
    } catch { /* skip */ }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.filter(r => r.score >= 5).slice(0, limit).map(r => r.rel)
}

/** Resolves explicit mentions + automatic context + sticky items into one budgeted block of text. */
export async function buildContext(inp: BuildContextInput): Promise<BuiltContext> {
  const { session, root, settings: s, agent, editor } = inp
  const items: ContextItem[] = session.context.filter(i => !i.auto).map(i => ({ ...i }))
  const has = (kind: string, path?: string) => items.some(i => i.kind === kind && i.path === path)
  const text = inp.userText
  const lower = text.toLowerCase()

  // explicit @mentions (and @path tokens typed by hand)
  const mentions = [...inp.mentions]
  if (root) {
    for (const m of text.matchAll(/(?:^|\s)@([\w./\\\-]+)/g)) {
      const tok = m[1]
      if (mentions.some(x => x.value === tok)) continue
      try { const st = await fsp.stat(join(root, tok)); mentions.push({ kind: st.isDirectory() ? 'folder' : 'file', value: join(root, tok) }) } catch { /* not a path */ }
    }
  }
  for (const m of mentions) {
    if (m.kind === 'agent') continue
    if (m.kind === 'url') {
      if (items.some(i => i.kind === 'url' && i.path === m.value)) continue
      try { const page = await fetchPageText(m.value, 60_000); items.push(mkItem({ kind: 'url', label: page.title || m.value, path: m.value, content: page.text, priority: 4, once: true })) }
      catch (e) { items.push(mkItem({ kind: 'note', label: `Could not fetch ${m.value}`, content: `Fetching ${m.value} failed: ${(e as Error).message}`, priority: 2, once: true })) }
      continue
    }
    const abs = m.value
    if (has(m.kind, abs)) continue
    items.push(mkItem({ kind: m.kind, label: relPath(root, abs) || basename(abs), path: abs, priority: 5, once: true }))
  }

  // automatic context
  if (s.ai.autoContext && agent.contextRules?.autoContext !== false) {
    if (editor?.selection && editor.selection.text.trim()) {
      items.push(mkItem({ kind: 'selection', label: `${basename(editor.selection.path)}:${editor.selection.startLine}-${editor.selection.endLine}`, path: editor.selection.path, range: { startLine: editor.selection.startLine, endLine: editor.selection.endLine }, content: editor.selection.text, auto: true, priority: 5 }))
    }
    if (editor?.activeFile && !has('file', editor.activeFile)) {
      items.push(mkItem({ kind: 'file', label: relPath(root, editor.activeFile), path: editor.activeFile, auto: true, priority: editor.selection ? 3 : 4 }))
    }
    if (editor?.openTabs?.length) {
      items.push(mkItem({ kind: 'tabs', label: `${editor.openTabs.length} open tabs`, content: editor.openTabs.map(t => relPath(root, t)).join('\n'), auto: true, priority: 1 }))
    }
    const wantsDiag = /error|fix|problem|warning|broken|bug|diagnos|doesn'?t work|fail|ошибк|исправ/.test(lower)
    if (editor?.diagnostics?.length && (wantsDiag || editor.diagnostics.some(d => d.severity === 'error'))) {
      const lines = editor.diagnostics.filter(d => d.severity !== 'info').slice(0, 60).map(d => `${relPath(root, d.path)}:${d.line} ${d.severity}: ${d.message}`)
      if (lines.length) items.push(mkItem({ kind: 'diagnostics', label: `${lines.length} problems`, content: lines.join('\n'), auto: true, priority: 4 }))
    }
    if (editor?.terminalTail && /error|fail|test|build|output|terminal|console|crash|trace|exception|ошибк|консол|терминал/.test(lower)) {
      items.push(mkItem({ kind: 'terminal', label: 'Terminal output', content: editor.terminalTail.slice(-8000), auto: true, priority: 3 }))
    }
    if (root && /\b(diff|changes|changed|commit|review|pr\b|pull request|staged|uncommitted)\b|изменени|коммит/.test(lower)) {
      const r = await run('git', ['diff', 'HEAD', '--no-color', '--stat', '-p'], { cwd: root, timeoutMs: 8000, maxBuffer: 60_000 })
      if (r.code === 0 && r.stdout.trim()) items.push(mkItem({ kind: 'diff', label: 'Git diff', content: r.stdout, auto: true, priority: 4 }))
    }
    // files referenced by name
    if (root) {
      const named = [...new Set(text.match(/[\w./\\-]+\.[A-Za-z0-9]{1,6}\b/g) ?? [])].slice(0, 6)
      if (named.length) {
        const all = await fileIndex.list(root, 60_000)
        for (const n of named) {
          const norm = n.replace(/\\/g, '/')
          const exact = all.filter(f => f === norm || f.endsWith('/' + norm))
          if (exact.length === 1 && !has('file', join(root, exact[0])) && !items.some(i => i.path === join(root, exact[0]))) items.push(mkItem({ kind: 'file', label: exact[0], path: join(root, exact[0]), auto: true, priority: 4 }))
        }
      }
      if (text.trim().split(/\s+/).length >= 4 && !items.some(i => i.auto && i.kind === 'file' && i.priority === 4 && !editor?.activeFile)) {
        for (const rel of await retrieve(root, text, s.context.excludePatterns)) {
          const abs = join(root, rel)
          if (!items.some(i => i.path === abs)) items.push(mkItem({ kind: 'file', label: rel, path: abs, auto: true, priority: 2, note: 'matched your request' }))
        }
      }
    }
  }

  // resolve + budget
  const available = Math.max(2000, Math.floor(inp.window * 0.9) - inp.systemTokens - inp.historyTokens - inp.reserveOutput)
  const order = [...items].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.priority - a.priority) || (Number(a.auto) - Number(b.auto)))
  let used = 0
  const bodies = new Map<string, string>()
  const images: ImageData[] = []
  for (const it of order) {
    if (!it.enabled) { it.tokens = it.tokens || 0; continue }
    let r: Awaited<ReturnType<typeof resolveItem>> = null
    try { r = await resolveItem(it, root, s) } catch (e) { it.note = `unreadable: ${(e as Error).message}`; it.enabled = it.enabled; continue }
    if (!r) { it.note = 'excluded'; it.tokens = 0; continue }
    if (r.image) {
      if (used + IMAGE_TOKENS > available) { it.note = 'dropped (over budget)'; it.tokens = IMAGE_TOKENS; continue }
      images.push(r.image); it.tokens = IMAGE_TOKENS; used += IMAGE_TOKENS; it.note = undefined
      continue
    }
    let body = r.body
    let tok = Math.ceil(estimateTokens(body) * inp.ratio)
    if (used + tok > available) {
      const room = available - used
      if (it.pinned || it.priority >= 4) {
        if (room < 300) { it.note = 'dropped (over budget)'; it.tokens = tok; continue }
        const t = truncateTokens(body, Math.floor(room / inp.ratio))
        body = t.text; tok = Math.ceil(estimateTokens(body) * inp.ratio); it.truncated = true
      } else { it.note = 'dropped (over budget)'; it.tokens = tok; continue }
    }
    it.tokens = tok
    it.truncated = r.truncated || it.truncated
    if (it.note?.startsWith('dropped')) it.note = undefined
    used += tok
    bodies.set(it.id, body)
  }
  // keep original (display) order
  const rendered = items.filter(i => bodies.has(i.id)).map(i => bodies.get(i.id)!)
  const block = rendered.length ? `<attached_context>\n${rendered.join('\n\n')}\n</attached_context>` : ''
  const snapshot: ContextSnapshot = { items, used: used + inp.systemTokens + inp.historyTokens, window: inp.window, history: inp.historyTokens, system: inp.systemTokens, budgetItems: used }
  return { text: block, images, snapshot, items }
}

/** Re-computes the snapshot totals without resolving content (for the live meter). */
export function quickSnapshot(session: Session, window: number, system: number, history: number): ContextSnapshot {
  const used = session.context.filter(i => i.enabled).reduce((n, i) => n + i.tokens, 0)
  return { items: session.context, used: used + system + history, window, history, system, budgetItems: used }
}
