import { promises as fsp } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { languageForPath } from '../../shared/languages'
import type {
  LspApi, LspCallItem, LspCodeAction, LspCompletionItem, LspDiagnostic, LspFileEdits, LspLocation, LspPos, LspRange, LspServerStatus, LspSignatureHelp, LspSymbol, LspTextEdit
} from '../../shared/dev'
import type { LspServerConfig } from '../../shared/settings'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { emit, bus } from '../services/events'
import { log } from '../services/log'
import { run } from '../services/proc'
import { LspClient, fromUri, toUri } from './lsp-client'

const TS_LANGS = new Set(['typescript', 'javascript'])
const COMPLETION_KINDS = ['', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder', 'enumMember', 'constant', 'struct', 'event', 'operator', 'typeParameter']
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter']
const SEV: LspDiagnostic['severity'][] = ['error', 'error', 'warning', 'info', 'hint']

interface Doc { text: string; languageId: string; version: number; backend: string | null; transient: boolean }

const rng = (r: any): LspRange => ({ line: r.start.line + 1, col: r.start.character + 1, endLine: r.end.line + 1, endCol: r.end.character + 1 })
const lspRange = (r: LspRange) => ({ start: { line: r.line - 1, character: r.col - 1 }, end: { line: r.endLine - 1, character: r.endCol - 1 } })
const lspPos = (p: LspPos) => ({ line: p.line - 1, character: p.col - 1 })
const md = (v: any): string => !v ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(md).join('\n\n') : v.kind ? v.value : v.language ? '```' + v.language + '\n' + v.value + '\n```' : String(v.value ?? '')

function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const off = (line: number, col: number) => Math.min(text.length, (starts[Math.min(line - 1, starts.length - 1)] ?? 0) + col - 1)
  const sorted = [...edits].sort((a, b) => off(b.line, b.col) - off(a.line, a.col))
  let out = text
  for (const e of sorted) out = out.slice(0, off(e.line, e.col)) + e.newText + out.slice(off(e.endLine, e.endCol))
  return out
}

class LanguageManager implements LspApi {
  private worker: Worker | null = null
  private wreq = new Map<number, { resolve(v: any): void; reject(e: Error): void }>()
  private wseq = 0
  private clients = new Map<string, LspClient>()
  private starting = new Map<string, Promise<LspClient | null>>()
  private docs = new Map<string, Doc>()
  private diags = new Map<string, LspDiagnostic[]>()
  private diagTimer: NodeJS.Timeout | null = null
  private root: string | null = null
  private notFound = new Set<string>()
  private errors = new Map<string, string>()

  constructor() {
    bus.on('workspace:changed', (w: { root: string | null }) => { void this.reset(w.root) })
    bus.on('fs:changed:internal', (events: { path: string }[]) => this.onDiskChange(events.map(e => e.path)))
  }

  // ───────────── lifecycle ─────────────
  private workerPath(): string {
    if (process.env.TGG_TS_WORKER) return process.env.TGG_TS_WORKER
    const p = join(__dirname, 'ts-worker.cjs')
    const unpacked = p.replace('app.asar', 'app.asar.unpacked')
    return existsSync(unpacked) ? unpacked : p
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    if (!settings.get().lsp.enabled || !settings.get().lsp.typescript) return null
    try {
      const w = new Worker(this.workerPath())
      w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
        const p = this.wreq.get(m.id)
        if (!p) return
        this.wreq.delete(m.id)
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result)
      })
      w.on('error', (e: Error) => { log.error('lsp', `TypeScript service crashed: ${e.message}`); this.errors.set('typescript', e.message); this.worker = null; for (const p of this.wreq.values()) p.reject(e); this.wreq.clear() })
      w.on('exit', () => { this.worker = null })
      this.worker = w
      if (this.root) void this.tsCall('setRoot', { root: this.root })
      for (const [path, d] of this.docs) if (d.backend === 'typescript') void this.tsCall('open', { path, text: d.text, version: d.version })
      return w
    } catch (e) { this.errors.set('typescript', (e as Error).message); return null }
  }

  private tsCall<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    const w = this.ensureWorker()
    if (!w) return Promise.reject(new Error('The TypeScript language service is not available.'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.wseq
      const t = setTimeout(() => { this.wreq.delete(id); reject(new Error(`TypeScript ${method} timed out`)) }, 30_000)
      this.wreq.set(id, { resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) } })
      w.postMessage({ id, method, params })
    })
  }

  async reset(root: string | null): Promise<void> {
    this.root = root
    for (const c of this.clients.values()) await c.stop().catch(() => undefined)
    this.clients.clear(); this.starting.clear(); this.docs.clear(); this.diags.clear(); this.notFound.clear()
    if (this.worker) { if (root) await this.tsCall('setRoot', { root }).catch(() => undefined) }
    emit('lsp:status', await this.status())
  }

  private onDiskChange(paths: string[]): void {
    let tsTouched = false
    for (const p of paths) {
      if (/\.(tsx?|jsx?|mjs|cjs|json)$/.test(p) || /(ts|js)config/.test(p)) tsTouched = true
      const d = this.docs.get(p)
      if (d?.transient) void fsp.readFile(p, 'utf8').then(text => { d.text = text; d.version++; void this.pushChange(p, d) }).catch(() => { this.docs.delete(p) })
    }
    if (tsTouched && this.worker) { void this.tsCall('invalidate', {}).catch(() => undefined); this.scheduleDiagnostics() }
  }

  // ───────────── routing ─────────────
  private serverFor(languageId: string): { id: string; cfg: LspServerConfig } | null {
    const s = settings.get().lsp
    if (!s.enabled) return null
    for (const [id, cfg] of Object.entries(s.servers)) if (cfg.enabled && cfg.languages.includes(languageId)) return { id, cfg }
    return null
  }

  private backendFor(languageId: string): string | null {
    if (TS_LANGS.has(languageId)) return settings.get().lsp.typescript && settings.get().lsp.enabled ? 'typescript' : null
    return this.serverFor(languageId)?.id ?? null
  }

  private async client(id: string): Promise<LspClient | null> {
    const existing = this.clients.get(id)
    if (existing && existing.state === 'running') return existing
    const inflight = this.starting.get(id)
    if (inflight) return inflight
    const cfg = settings.get().lsp.servers[id]
    if (!cfg || !this.root || this.notFound.has(id)) return null
    const p = (async () => {
      const c = new LspClient(id, cfg.command, cfg.args ?? [], this.root!)
      c.on('diagnostics', (params: { uri: string; diagnostics: any[] }) => this.onPublish(fromUri(params.uri), params.diagnostics))
      c.on('exit', () => { this.clients.delete(id); emit('lsp:status', undefined) })
      try {
        await c.start()
        this.clients.set(id, c)
        for (const [path, d] of this.docs) if (d.backend === id) c.notify('textDocument/didOpen', { textDocument: { uri: toUri(path), languageId: d.languageId, version: d.version, text: d.text } })
        log.info('lsp', `${id} language server started`)
        emit('lsp:status', undefined)
        return c
      } catch (e) {
        this.errors.set(id, (e as Error).message)
        if (/not found/.test((e as Error).message)) this.notFound.add(id)
        log.warn('lsp', `${id}: ${(e as Error).message}`)
        emit('lsp:status', undefined)
        return null
      } finally { this.starting.delete(id) }
    })()
    this.starting.set(id, p)
    return p
  }

  private onPublish(path: string, raw: any[]): void {
    const list: LspDiagnostic[] = raw.map(d => ({ ...rng(d.range), severity: SEV[d.severity ?? 1] ?? 'error', message: d.message, code: typeof d.code === 'object' ? d.code?.value : d.code, source: d.source, unnecessary: d.tags?.includes(1), deprecated: d.tags?.includes(2) }))
    this.diags.set(path, list)
    emit('lsp:diagnostics', { path, diagnostics: list })
  }

  private scheduleDiagnostics(): void {
    if (this.diagTimer) clearTimeout(this.diagTimer)
    this.diagTimer = setTimeout(() => {
      this.diagTimer = null
      for (const [path, d] of this.docs) if (d.backend === 'typescript' && !d.transient) void this.refreshTsDiagnostics(path)
    }, 450)
  }

  private async refreshTsDiagnostics(path: string): Promise<LspDiagnostic[]> {
    try {
      const list = await this.tsCall<LspDiagnostic[]>('diagnostics', { path })
      this.diags.set(path, list)
      emit('lsp:diagnostics', { path, diagnostics: list })
      return list
    } catch { return this.diags.get(path) ?? [] }
  }

  // ───────────── documents ─────────────
  private async pushOpen(path: string, d: Doc): Promise<void> {
    if (d.backend === 'typescript') { await this.tsCall('open', { path, text: d.text, version: d.version }).catch(() => undefined); this.scheduleDiagnostics() }
    else if (d.backend) { const c = await this.client(d.backend); c?.notify('textDocument/didOpen', { textDocument: { uri: toUri(path), languageId: d.languageId, version: d.version, text: d.text } }) }
  }
  private async pushChange(path: string, d: Doc): Promise<void> {
    if (d.backend === 'typescript') { await this.tsCall('change', { path, text: d.text, version: d.version }).catch(() => undefined); this.scheduleDiagnostics() }
    else if (d.backend) { const c = this.clients.get(d.backend); c?.notify('textDocument/didChange', { textDocument: { uri: toUri(path), version: d.version }, contentChanges: [{ text: d.text }] }) }
  }

  async open(path: string, text: string, languageId: string, version: number): Promise<void> {
    const existing = this.docs.get(path)
    const d: Doc = { text, languageId, version, backend: this.backendFor(languageId), transient: false }
    this.docs.set(path, d)
    if (existing?.backend === d.backend && existing) await this.pushChange(path, d); else await this.pushOpen(path, d)
  }
  async change(path: string, text: string, version: number): Promise<void> {
    const d = this.docs.get(path)
    if (!d) return this.open(path, text, languageForPath(path), version)
    d.text = text; d.version = version; d.transient = false
    await this.pushChange(path, d)
  }
  async close(path: string): Promise<void> {
    const d = this.docs.get(path)
    if (!d) return
    this.docs.delete(path); this.diags.delete(path)
    if (d.backend === 'typescript') await this.tsCall('close', { path }).catch(() => undefined)
    else if (d.backend) this.clients.get(d.backend)?.notify('textDocument/didClose', { textDocument: { uri: toUri(path) } })
    emit('lsp:diagnostics', { path, diagnostics: [] })
  }

  /** Make sure a file is known to its language backend (used by the agent when the editor has not opened it). */
  async ensureOpen(path: string): Promise<Doc | null> {
    const d = this.docs.get(path)
    if (d) return d
    const languageId = languageForPath(path)
    if (!this.backendFor(languageId)) return null
    let text: string
    try { text = await fsp.readFile(path, 'utf8') } catch { return null }
    const nd: Doc = { text, languageId, version: 1, backend: this.backendFor(languageId), transient: true }
    this.docs.set(path, nd)
    await this.pushOpen(path, nd)
    return nd
  }

  private async withBackend<T>(path: string, ts: () => Promise<T>, lsp: (c: LspClient, uri: string, d: Doc) => Promise<T>, fallback: T): Promise<T> {
    const d = await this.ensureOpen(path)
    if (!d || !d.backend) return fallback
    try {
      if (d.backend === 'typescript') return await ts()
      const c = await this.client(d.backend)
      if (!c) return fallback
      return await lsp(c, toUri(path), d)
    } catch (e) {
      log.debug('lsp', `${d.backend}: ${(e as Error).message}`)
      if (/not part of a TypeScript/.test((e as Error).message)) return fallback
      throw e
    }
  }

  // ───────────── conversions (LSP → shared) ─────────────
  private async locations(res: any): Promise<LspLocation[]> {
    const arr: any[] = !res ? [] : Array.isArray(res) ? res : [res]
    const out: LspLocation[] = []
    const cache = new Map<string, string[]>()
    for (const l of arr.slice(0, 300)) {
      const uri = l.uri ?? l.targetUri
      const range = l.range ?? l.targetSelectionRange ?? l.targetRange
      if (!uri || !range) continue
      const path = fromUri(uri)
      let lines = cache.get(path)
      if (!lines) { try { lines = (await fsp.readFile(path, 'utf8')).split('\n') } catch { lines = [] } cache.set(path, lines) }
      out.push({ path, ...rng(range), preview: lines[range.start.line]?.trim().slice(0, 200) })
    }
    return out
  }

  private editsFromWorkspaceEdit(we: any): LspFileEdits[] {
    const out: LspFileEdits[] = []
    if (!we) return out
    for (const [uri, edits] of Object.entries(we.changes ?? {})) out.push({ path: fromUri(uri), edits: (edits as any[]).map(e => ({ ...rng(e.range), newText: e.newText })) })
    for (const dc of we.documentChanges ?? []) if (dc.textDocument && dc.edits) out.push({ path: fromUri(dc.textDocument.uri), edits: dc.edits.map((e: any) => ({ ...rng(e.range), newText: e.newText })) })
    return out
  }

  private symbols(items: any[], path?: string): LspSymbol[] {
    return (items ?? []).map(s => {
      const loc = s.location
      const range = s.range ?? loc?.range
      const sel = s.selectionRange ?? range
      return {
        name: s.name, kind: SYMBOL_KINDS[s.kind] ?? 'variable', detail: s.detail, containerName: s.containerName, path: loc ? fromUri(loc.uri) : path,
        ...(range ? rng(sel ?? range) : { line: 1, col: 1, endLine: 1, endCol: 1 }),
        children: s.children?.length ? this.symbols(s.children, path) : undefined
      } as LspSymbol
    })
  }

  // ───────────── API ─────────────
  async definition(path: string, pos: LspPos) {
    return this.withBackend<LspLocation[]>(path, () => this.tsCall('definition', { path, pos }), async (c, uri) => this.locations(await c.request('textDocument/definition', { textDocument: { uri }, position: lspPos(pos) })), [])
  }
  async typeDefinition(path: string, pos: LspPos) {
    return this.withBackend<LspLocation[]>(path, () => this.tsCall('typeDefinition', { path, pos }), async (c, uri) => this.locations(await c.request('textDocument/typeDefinition', { textDocument: { uri }, position: lspPos(pos) })), [])
  }
  async implementation(path: string, pos: LspPos) {
    return this.withBackend<LspLocation[]>(path, () => this.tsCall('implementation', { path, pos }), async (c, uri) => this.locations(await c.request('textDocument/implementation', { textDocument: { uri }, position: lspPos(pos) })), [])
  }
  async references(path: string, pos: LspPos) {
    return this.withBackend<LspLocation[]>(path, () => this.tsCall('references', { path, pos }), async (c, uri) => this.locations(await c.request('textDocument/references', { textDocument: { uri }, position: lspPos(pos), context: { includeDeclaration: true } }, 40_000)), [])
  }
  async hover(path: string, pos: LspPos) {
    return this.withBackend<{ contents: string; range?: LspRange } | null>(path, () => this.tsCall('hover', { path, pos }), async (c, uri) => {
      const r = await c.request('textDocument/hover', { textDocument: { uri }, position: lspPos(pos) })
      const contents = md(r?.contents)
      return contents.trim() ? { contents, range: r.range ? rng(r.range) : undefined } : null
    }, null)
  }
  async completion(path: string, pos: LspPos, trigger?: string) {
    return this.withBackend<{ items: LspCompletionItem[]; incomplete: boolean }>(path, () => this.tsCall('completion', { path, pos, trigger }), async (c, uri) => {
      const r = await c.request('textDocument/completion', { textDocument: { uri }, position: lspPos(pos), context: trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 } })
      const list: any[] = Array.isArray(r) ? r : r?.items ?? []
      const items = list.slice(0, 400).map((i): LspCompletionItem => {
        const te = i.textEdit
        const range = te ? (te.range ?? te.replace) : undefined
        return {
          label: typeof i.label === 'string' ? i.label : i.label?.label ?? '', kind: COMPLETION_KINDS[i.kind] ?? 'text', detail: i.detail ?? i.labelDetails?.detail, documentation: md(i.documentation) || undefined,
          sortText: i.sortText, filterText: i.filterText, insertText: te?.newText ?? i.insertText ?? i.label, range: range ? rng(range) : undefined, isSnippet: i.insertTextFormat === 2,
          deprecated: i.deprecated || i.tags?.includes(1), commitCharacters: i.commitCharacters, preselect: i.preselect, data: i.data !== undefined ? { raw: { label: i.label, kind: i.kind, data: i.data } } : undefined
        }
      })
      return { items, incomplete: !Array.isArray(r) && !!r?.isIncomplete }
    }, { items: [], incomplete: false })
  }
  async completionResolve(path: string, pos: LspPos, item: LspCompletionItem) {
    return this.withBackend<{ documentation?: string; detail?: string; additionalEdits?: LspTextEdit[] }>(path, () => this.tsCall('completionResolve', { path, pos, item }), async c => {
      const raw = (item.data as { raw?: unknown } | undefined)?.raw
      if (!raw) return {}
      const r = await c.request('completionItem/resolve', raw, 8000)
      return { documentation: md(r?.documentation) || undefined, detail: r?.detail, additionalEdits: (r?.additionalTextEdits ?? []).map((e: any) => ({ ...rng(e.range), newText: e.newText })) }
    }, {})
  }
  async signatureHelp(path: string, pos: LspPos, trigger?: string) {
    return this.withBackend<LspSignatureHelp | null>(path, () => this.tsCall('signatureHelp', { path, pos, trigger }), async (c, uri) => {
      const r = await c.request('textDocument/signatureHelp', { textDocument: { uri }, position: lspPos(pos) })
      if (!r?.signatures?.length) return null
      return {
        activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0,
        signatures: r.signatures.map((s: any) => ({ label: s.label, documentation: md(s.documentation) || undefined, parameters: (s.parameters ?? []).map((p: any) => ({ label: Array.isArray(p.label) ? s.label.slice(p.label[0], p.label[1]) : p.label, documentation: md(p.documentation) || undefined })) }))
      }
    }, null)
  }
  async prepareRename(path: string, pos: LspPos) {
    return this.withBackend<{ range: LspRange; text: string } | null>(path, () => this.tsCall('prepareRename', { path, pos }), async (c, uri) => {
      const r = await c.request('textDocument/prepareRename', { textDocument: { uri }, position: lspPos(pos) })
      if (!r) return null
      const range = r.range ?? r
      const d = this.docs.get(path)
      const lines = (d?.text ?? '').split('\n')
      const l = lines[range.start.line] ?? ''
      return { range: rng(range), text: r.placeholder ?? l.slice(range.start.character, range.end.character) }
    }, null)
  }
  async rename(path: string, pos: LspPos, newName: string) {
    return this.withBackend<LspFileEdits[]>(path, () => this.tsCall('rename', { path, pos, newName }), async (c, uri) => this.editsFromWorkspaceEdit(await c.request('textDocument/rename', { textDocument: { uri }, position: lspPos(pos), newName }, 40_000)), [])
  }
  async documentSymbols(path: string) {
    return this.withBackend<LspSymbol[]>(path, () => this.tsCall('documentSymbols', { path }), async (c, uri) => this.symbols(await c.request('textDocument/documentSymbol', { textDocument: { uri } }), path), [])
  }
  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    const out: LspSymbol[] = []
    if (this.worker || [...this.docs.values()].some(d => d.backend === 'typescript')) out.push(...await this.tsCall<LspSymbol[]>('workspaceSymbols', { query }).catch(() => []))
    for (const c of this.clients.values()) { try { out.push(...this.symbols(await c.request('workspace/symbol', { query }, 15000) ?? [])) } catch { /* unsupported */ } }
    return out
  }
  async diagnostics(path: string) {
    const d = await this.ensureOpen(path)
    if (!d?.backend) return []
    if (d.backend === 'typescript') return this.refreshTsDiagnostics(path)
    await new Promise(r => setTimeout(r, 600))
    return this.diags.get(path) ?? []
  }
  async codeActions(path: string, range: LspRange, diagnostics: LspDiagnostic[]) {
    return this.withBackend<LspCodeAction[]>(path, () => this.tsCall('codeActions', { path, range, diagnostics }), async (c, uri) => {
      const r: any[] = (await c.request('textDocument/codeAction', { textDocument: { uri }, range: lspRange(range), context: { diagnostics: diagnostics.map(d => ({ range: lspRange(d), message: d.message, severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3, code: d.code, source: d.source })) } })) ?? []
      return r.filter(a => a.edit).map(a => ({ title: a.title, kind: a.kind, edits: this.editsFromWorkspaceEdit(a.edit), isPreferred: a.isPreferred }))
    }, [])
  }
  async format(path: string, opts: { tabSize: number; insertSpaces: boolean }) {
    return this.withBackend<LspTextEdit[]>(path, () => this.tsCall('format', { path, opts }), async (c, uri) => ((await c.request('textDocument/formatting', { textDocument: { uri }, options: opts })) ?? []).map((e: any) => ({ ...rng(e.range), newText: e.newText })), [])
  }
  async organizeImports(path: string) {
    return this.withBackend<LspFileEdits[]>(path, () => this.tsCall('organizeImports', { path }), async () => [], [])
  }
  async callHierarchy(path: string, pos: LspPos, direction: 'prepare' | 'incoming' | 'outgoing', item?: LspCallItem) {
    return this.withBackend<LspCallItem[]>(path, () => this.tsCall('callHierarchy', { path, pos, direction, item }), async (c, uri) => {
      const conv = (i: any): LspCallItem => ({ name: i.name, kind: SYMBOL_KINDS[i.kind] ?? 'function', path: fromUri(i.uri), detail: i.detail, range: rng(i.range), selection: rng(i.selectionRange), data: { raw: i } })
      if (direction === 'prepare') return ((await c.request('textDocument/prepareCallHierarchy', { textDocument: { uri }, position: lspPos(pos) })) ?? []).map(conv)
      const raw = (item?.data as { raw?: unknown } | undefined)?.raw
      if (!raw) return []
      const r: any[] = (await c.request(direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item: raw })) ?? []
      return r.map(x => conv(direction === 'incoming' ? x.from : x.to))
    }, [])
  }

  async allDiagnostics() { return Object.fromEntries(this.diags) }

  async status(): Promise<LspServerStatus[]> {
    const s = settings.get().lsp
    const out: LspServerStatus[] = [{ id: 'typescript', label: 'TypeScript / JavaScript', languages: ['typescript', 'javascript'], command: 'built-in', state: !s.enabled || !s.typescript ? 'disabled' : this.errors.has('typescript') && !this.worker ? 'error' : this.worker ? 'running' : 'stopped', message: this.errors.get('typescript') }]
    for (const [id, cfg] of Object.entries(s.servers)) {
      const c = this.clients.get(id)
      const found = !!LspClient.resolveCommand(cfg.command)
      out.push({ id, label: id, languages: cfg.languages, command: cfg.command, state: !s.enabled || !cfg.enabled ? 'disabled' : c?.state === 'running' ? 'running' : this.starting.has(id) ? 'starting' : !found ? 'missing' : this.errors.has(id) && !c ? 'error' : 'stopped', message: !found ? `"${cfg.command}" is not installed or not on PATH` : this.errors.get(id) })
    }
    return out
  }

  async restart(id?: string) {
    if (!id || id === 'typescript') { await this.worker?.terminate(); this.worker = null; this.errors.delete('typescript'); if (this.root) { this.ensureWorker(); this.scheduleDiagnostics() } }
    for (const [cid, c] of [...this.clients]) if (!id || id === cid) { await c.stop().catch(() => undefined); this.clients.delete(cid); this.errors.delete(cid); this.notFound.delete(cid) }
    emit('lsp:status', await this.status())
  }

  async externalFormat(path: string, text: string, languageId: string): Promise<string | null> {
    const f = settings.get().formatters[languageId]
    if (!f?.enabled) return null
    const r = await run(f.command, (f.args ?? []).map(a => a.replace('{file}', path)), { cwd: workspace.root ?? undefined, input: text, timeoutMs: 15_000 })
    return r.code === 0 && r.stdout ? r.stdout : null
  }

  async applyEditsToDisk(files: LspFileEdits[]) {
    for (const f of files) {
      const text = await fsp.readFile(f.path, 'utf8')
      await fsp.writeFile(f.path, applyTextEdits(text, f.edits), 'utf8')
    }
  }

  /** Errors reported for a file shortly after the agent edited it. */
  async diagnosticsAfterEdit(paths: string[]): Promise<string> {
    const lines: string[] = []
    for (const path of paths.slice(0, 5)) {
      const languageId = languageForPath(path)
      if (!this.backendFor(languageId)) continue
      try {
        let d = this.docs.get(path)
        const text = await fsp.readFile(path, 'utf8')
        if (!d) { await this.ensureOpen(path); d = this.docs.get(path) }
        else if (d.transient) { d.text = text; d.version++; await this.pushChange(path, d) }
        else if (d.text !== text) { /* editor owns the buffer; disk watcher will refresh it */ d = { ...d, text } }
        const list = d?.backend === 'typescript' ? await (async () => { await this.tsCall('change', { path, text, version: (this.docs.get(path)?.version ?? 1) + 1000 }).catch(() => undefined); return this.refreshTsDiagnostics(path) })() : await this.diagnostics(path)
        for (const x of list.filter(x => x.severity === 'error').slice(0, 10)) lines.push(`${path}:${x.line}:${x.col} error${x.code ? ` ${x.code}` : ''}: ${x.message.split('\n')[0]}`)
      } catch { /* diagnostics are best-effort */ }
    }
    return lines.length ? `Language server found problems after your edit:\n${lines.join('\n')}` : ''
  }

  shutdown(): void { void this.worker?.terminate(); for (const c of this.clients.values()) void c.stop() }
}

export const lsp = new LanguageManager()
