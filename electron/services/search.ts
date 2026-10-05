import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { SearchOptions, SearchFileResult, SearchResult } from '../../shared/fs'
import { workspace } from './workspace'
import { fileIndex } from './fileindex'
import { settings } from './settings'
import { isBinaryBuffer } from './fsapi'

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function compileGlobList(list: string): ((p: string) => boolean) | null {
  const parts = list.split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return null
  const patterns = parts.flatMap(p => {
    const clean = p.replace(/\\/g, '/').replace(/^\.\//, '')
    if (/[*?{]/.test(clean)) return [clean, clean.endsWith('/**') ? clean : `${clean}/**`]
    return [clean, `${clean}/**`, `**/${clean}`, `**/${clean}/**`]
  })
  const m = picomatch(patterns, { dot: true })
  return (p: string) => m(p)
}

export function buildRegex(o: Pick<SearchOptions, 'query' | 'isRegex' | 'caseSensitive' | 'wholeWord'>, extraFlags = ''): RegExp {
  let src = o.isRegex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (o.wholeWord) src = `\\b(?:${src})\\b`
  return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i') + extraFlags)
}

const active = new Map<string, AbortController>()

export const searchApi = {
  cancel(id: string) { active.get(id)?.abort() },

  async search(o: SearchOptions, searchId = 'default'): Promise<SearchResult> {
    const root = workspace.requireRoot()
    active.get(searchId)?.abort()
    const ac = new AbortController()
    active.set(searchId, ac)
    const t0 = Date.now()
    if (!o.query) return { files: [], totalMatches: 0, truncated: false, searchedFiles: 0, durationMs: 0 }
    const multiline = /\\n|\n/.test(o.query)
    const re = buildRegex(o, multiline ? 'm' : '')
    const include = compileGlobList(o.include)
    const exclude = compileGlobList(o.exclude)
    const settingsExclude = o.useExcludeSettings === false ? null : picomatch(settings.effective(root).context.excludePatterns.filter(p => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|dll)$/.test(p)), { dot: true })
    const max = o.maxResults ?? 3000

    const all = await fileIndex.list(root, 5000)
    const files = all.filter(f => (!include || include(f)) && (!exclude || !exclude(f)) && !(settingsExclude && settingsExclude(f)))
    const results: SearchFileResult[] = []
    let total = 0
    let searched = 0
    let truncated = false
    let idx = 0

    const worker = async () => {
      while (!ac.signal.aborted && !truncated) {
        const i = idx++
        if (i >= files.length) return
        const rel = files[i]
        const full = join(root, rel)
        try {
          const st = await fsp.stat(full)
          if (st.size > MAX_FILE_BYTES || st.size === 0) continue
          const buf = await fsp.readFile(full)
          if (isBinaryBuffer(buf)) continue
          searched++
          const text = buf.toString('utf8')
          const matches = findMatches(text, re, multiline)
          if (matches.length) {
            if (total + matches.length > max) { matches.length = Math.max(0, max - total); truncated = true }
            total += matches.length
            results.push({ path: full, rel, matches })
          }
        } catch { /* unreadable */ }
      }
    }
    await Promise.all(Array.from({ length: 12 }, worker))
    active.delete(searchId)
    results.sort((a, b) => a.rel.localeCompare(b.rel))
    return { files: results, totalMatches: total, truncated, searchedFiles: searched, durationMs: Date.now() - t0 }
  },

  /** Replace all occurrences in the given files (or in every file that matches when `files` is omitted). */
  async replace(o: SearchOptions, replacement: string, files?: string[]): Promise<{ files: number; replacements: number }> {
    const root = workspace.requireRoot()
    const targets = files ?? (await searchApi.search({ ...o, maxResults: 100000 }, 'replace')).files.map(f => f.path)
    const multiline = /\\n|\n/.test(o.query)
    let n = 0
    let nf = 0
    for (const path of targets) {
      const full = path.startsWith(root) ? path : join(root, path)
      const text = await fsp.readFile(full, 'utf8')
      const re = buildRegex(o, multiline ? 'm' : '')
      let count = 0
      const next = text.replace(re, (...args) => {
        count++
        if (!o.isRegex) return replacement
        const m = args as unknown[]
        const groups = m.slice(1, m.findIndex(x => typeof x === 'number')) as string[]
        return replacement.replace(/\$(\d+|&|\$)/g, (_x, g: string) => g === '$' ? '$' : g === '&' ? String(m[0]) : (groups[Number(g) - 1] ?? ''))
      })
      if (count) { await fsp.writeFile(full, next, 'utf8'); n += count; nf++ }
    }
    return { files: nf, replacements: n }
  },

  async replaceOne(path: string, line: number, col: number, length: number, expected: string, replacement: string): Promise<boolean> {
    const text = await fsp.readFile(path, 'utf8')
    const lines = text.split('\n')
    const ln = lines[line - 1]
    if (ln === undefined || ln.substr(col - 1, length) !== expected) return false
    lines[line - 1] = ln.slice(0, col - 1) + replacement + ln.slice(col - 1 + length)
    await fsp.writeFile(path, lines.join('\n'), 'utf8')
    return true
  }
}

function findMatches(text: string, re: RegExp, multiline: boolean) {
  const out: SearchFileResult['matches'] = []
  if (multiline) {
    const lineStarts = [0]
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) && out.length < 500) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      let lo = 0, hi = lineStarts.length - 1
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= m.index) lo = mid; else hi = mid - 1 }
      const lineText = text.slice(lineStarts[lo], text.indexOf('\n', lineStarts[lo]) === -1 ? undefined : text.indexOf('\n', lineStarts[lo]))
      out.push(makeMatch(lineText.replace(/\r$/, ''), lo + 1, m.index - lineStarts[lo], Math.min(m[0].length, lineText.length - (m.index - lineStarts[lo]))))
    }
    return out
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < 500; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line.length > 5000) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) && out.length < 500) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      out.push(makeMatch(line, i + 1, m.index, m[0].length))
    }
  }
  return out
}

function makeMatch(line: string, lineNo: number, index: number, length: number) {
  const trimStart = Math.max(0, index - 40)
  const before = (trimStart > 0 ? '…' : '') + line.slice(trimStart, index).replace(/^\s+/, trimStart === 0 ? '' : '$&')
  return { line: lineNo, col: index + 1, length, before, text: line.slice(index, index + length), after: line.slice(index + length, index + length + 160) }
}
