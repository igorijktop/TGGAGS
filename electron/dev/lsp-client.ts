import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { killTree, which } from '../services/proc'
import { log } from '../services/log'

export const toUri = (p: string): string => pathToFileURL(p).toString()
export const fromUri = (u: string): string => { try { return fileURLToPath(u) } catch { return u.replace(/^file:\/\//, '') } }

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

/** Minimal JSON-RPC 2.0 client for Language Server Protocol servers over stdio. */
export class LspClient extends EventEmitter {
  state: 'stopped' | 'starting' | 'running' | 'error' = 'stopped'
  message = ''
  capabilities: Record<string, any> = {}
  private proc: ChildProcess | null = null
  private buf = Buffer.alloc(0)
  private seq = 0
  private pending = new Map<number, Pending>()

  constructor(readonly id: string, private command: string, private args: string[], private root: string) { super() }

  static resolveCommand(command: string): string | null { return which(command) ?? (command.includes('/') || command.includes('\\') ? command : null) }

  async start(): Promise<void> {
    const exe = LspClient.resolveCommand(this.command)
    if (!exe) { this.state = 'error'; this.message = `"${this.command}" was not found on PATH`; throw new Error(this.message) }
    this.state = 'starting'
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)
    this.proc = spawn(needsShell ? `"${exe}"` : exe, this.args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: needsShell })
    this.proc.stdout!.on('data', d => this.onData(d))
    this.proc.stderr!.on('data', d => log.debug(`lsp:${this.id}`, String(d).trimEnd()))
    this.proc.on('error', e => { this.state = 'error'; this.message = e.message; this.emit('exit') })
    this.proc.on('exit', code => { if (this.state !== 'stopped') { this.state = 'error'; this.message = `exited with code ${code}` } this.rejectAll(new Error('language server exited')); this.emit('exit') })

    const init: any = await this.request('initialize', {
      processId: process.pid, clientInfo: { name: 'TGGAGS IDE' }, rootUri: toUri(this.root), rootPath: this.root,
      workspaceFolders: [{ uri: toUri(this.root), name: 'workspace' }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceFolders: true, configuration: true, symbol: {}, applyEdit: false },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: false } } },
          definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true }, references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: { prepareSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source.organizeImports'] } } },
          callHierarchy: {}, formatting: {}, publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } }
        }
      }
    }, 45_000)
    this.capabilities = init?.capabilities ?? {}
    this.notify('initialized', {})
    this.state = 'running'
    this.emit('ready')
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buf.subarray(0, headerEnd).toString('ascii')
      const m = header.match(/content-length:\s*(\d+)/i)
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue }
      const len = Number(m[1])
      if (this.buf.length < headerEnd + 4 + len) return
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(headerEnd + 4 + len)
      try { this.handle(JSON.parse(body)) } catch (e) { log.warn(`lsp:${this.id}`, `bad message: ${(e as Error).message}`) }
    }
  }

  private handle(msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error) && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id); clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error')); else p.resolve(msg.result)
    } else if (msg.method && msg.id !== undefined) {
      // server → client request
      let result: unknown = null
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map(() => null)
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: toUri(this.root), name: 'workspace' }]
      this.send({ jsonrpc: '2.0', id: msg.id, result })
    } else if (msg.method) {
      this.emit('notification', msg.method, msg.params)
      if (msg.method === 'textDocument/publishDiagnostics') this.emit('diagnostics', msg.params)
    }
  }

  private send(obj: unknown): void {
    if (!this.proc?.stdin?.writable) return
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.proc.stdin.write(body)
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }) }

  private rejectAll(e: Error): void { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id) } }

  async stop(): Promise<void> {
    this.state = 'stopped'
    try { await this.request('shutdown', null, 2000); this.notify('exit', null) } catch { /* ignore */ }
    if (this.proc) killTree(this.proc)
    this.rejectAll(new Error('stopped'))
  }
}
