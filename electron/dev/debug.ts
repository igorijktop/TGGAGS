import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, promises as fsp } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Breakpoint, DebugApi, DebugFrame, DebugSnapshot, DebugState, DebugVariable, LaunchConfig } from '../../shared/dev'
import { emit } from '../services/events'
import { workspace } from '../services/workspace'
import { which, killTree } from '../services/proc'
import { PROJECT_DIR } from '../services/paths'
import { log } from '../services/log'
import { SourceMap, loadSourceMapFromUrl } from './sourcemap'
import { terminals } from './terminal'

interface Script { id: string; url: string; path: string | null; map: SourceMap | null }

type Cdp = Record<string, any>

function stripJsonComments(s: string): string {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (_m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function fmtValue(o: Cdp | undefined): { value: string; type?: string; ref?: string; expandable: boolean } {
  if (!o) return { value: 'undefined', expandable: false }
  if (o.type === 'string') return { value: JSON.stringify(o.value), type: 'string', expandable: false }
  if (o.type === 'undefined') return { value: 'undefined', type: 'undefined', expandable: false }
  if (o.subtype === 'null') return { value: 'null', type: 'null', expandable: false }
  if (o.type === 'number' || o.type === 'boolean') return { value: String(o.value ?? o.unserializableValue ?? o.description), type: o.type, expandable: false }
  if (o.type === 'bigint') return { value: o.description ?? String(o.unserializableValue), type: 'bigint', expandable: false }
  if (o.type === 'symbol') return { value: o.description, type: 'symbol', expandable: false }
  if (o.type === 'function') return { value: (o.description as string)?.split('\n')[0].slice(0, 120) ?? 'ƒ', type: 'function', ref: o.objectId, expandable: !!o.objectId }
  const desc = o.description ?? o.className ?? 'Object'
  return { value: o.subtype === 'error' ? String(desc).split('\n')[0] : desc, type: o.subtype ?? o.className ?? 'object', ref: o.objectId, expandable: !!o.objectId }
}

class DebugService implements DebugApi {
  private state: DebugState = 'inactive'
  private ws: any = null
  private child: ChildProcess | null = null
  private seq = 0
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>()
  private scripts = new Map<string, Script>()
  private bps = new Map<string, Breakpoint[]>()
  private cdpIds = new Map<string, string[]>()
  private frames: DebugFrame[] = []
  private cdpFrames: Cdp[] = []
  private pauseReason: string | undefined
  private exception: string | undefined
  private config: LaunchConfig | null = null
  private ctx: { file?: string } = {}
  private exceptionMode: 'none' | 'uncaught' | 'all' = 'uncaught'
  private stopOnEntryPending = false

  // ───────────── configs ─────────────
  private configPath(): string { return join(workspace.requireRoot(), PROJECT_DIR, 'launch.json') }

  async loadConfigs(): Promise<LaunchConfig[]> {
    const root = workspace.root
    if (!root) return []
    const out: LaunchConfig[] = []
    for (const f of [this.configPath(), join(root, '.vscode', 'launch.json')]) {
      try {
        const j = JSON.parse(stripJsonComments(await fsp.readFile(f, 'utf8'))) as { configurations?: any[] }
        for (const c of j.configurations ?? []) {
          if (!/node/.test(String(c.type))) continue
          out.push({ name: c.name, type: c.request === 'attach' ? 'node-attach' : 'node', request: c.request === 'attach' ? 'attach' : 'launch', program: c.program, args: c.args, cwd: c.cwd, env: c.env, runtimeExecutable: c.runtimeExecutable, runtimeArgs: c.runtimeArgs, port: c.port, stopOnEntry: c.stopOnEntry })
        }
      } catch { /* missing or invalid */ }
      if (out.length) break
    }
    const defaults: LaunchConfig[] = [{ name: 'Debug current file', type: 'node', request: 'launch', program: '${file}' }]
    try {
      const pkg = JSON.parse(await fsp.readFile(join(root, 'package.json'), 'utf8')) as { main?: string }
      if (pkg.main) defaults.unshift({ name: `Debug ${pkg.main}`, type: 'node', request: 'launch', program: '${workspaceFolder}/' + pkg.main })
    } catch { /* no package.json */ }
    defaults.push({ name: 'Attach to Node (9229)', type: 'node-attach', request: 'attach', port: 9229 })
    return [...out, ...defaults.filter(d => !out.some(o => o.name === d.name))]
  }

  async saveConfigs(cfgs: LaunchConfig[]): Promise<void> {
    const file = this.configPath()
    await fsp.mkdir(join(file, '..'), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ version: '1.0', configurations: cfgs }, null, 2))
  }

  private subst(s: string | undefined, root: string): string | undefined {
    if (s === undefined) return s
    return s.replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{file\}/g, this.ctx.file ?? '').replace(/\$\{env:(\w+)\}/g, (_m, k: string) => process.env[k] ?? '')
  }

  // ───────────── lifecycle ─────────────
  private setState(s: DebugState): void { this.state = s; emit('debug:state', this.buildSnapshot()) }
  private out(category: 'stdout' | 'stderr' | 'info' | 'error', text: string): void { emit('debug:output', { category, text }) }

  private buildSnapshot(): DebugSnapshot {
    return { state: this.state, configName: this.config?.name, frames: this.frames, pauseReason: this.pauseReason, exception: this.exception, pid: this.child?.pid }
  }
  async snapshot(): Promise<DebugSnapshot> { return this.buildSnapshot() }

  async start(cfg: LaunchConfig, debug: boolean, ctx?: { file?: string }): Promise<void> {
    if (this.state !== 'inactive' && this.state !== 'terminated') await this.stop()
    const root = workspace.requireRoot()
    this.ctx = ctx ?? {}
    this.config = cfg
    const program = this.subst(cfg.program, root)
    const cwd = this.subst(cfg.cwd, root) ?? root
    if (cfg.request === 'launch' && !program) throw new Error('This launch configuration has no "program". Open a JavaScript/TypeScript file and use "Debug current file", or edit .tgg/launch.json.')
    if (cfg.request === 'launch' && program && !existsSync(isAbsolute(program) ? program : resolve(cwd, program))) throw new Error(`Program not found: ${program}`)
    this.scripts.clear(); this.frames = []; this.cdpIds.clear(); this.pauseReason = undefined; this.exception = undefined

    if (cfg.request === 'attach') {
      this.setState('starting')
      this.out('info', `Attaching to localhost:${cfg.port ?? 9229}…`)
      const list = await (await fetch(`http://127.0.0.1:${cfg.port ?? 9229}/json/list`)).json() as { webSocketDebuggerUrl: string }[]
      if (!list[0]?.webSocketDebuggerUrl) throw new Error('No debuggable Node.js process found on that port.')
      await this.connect(list[0].webSocketDebuggerUrl)
      return
    }

    const useElectronNode = !cfg.runtimeExecutable && !which('node')
    const exe = cfg.runtimeExecutable ?? which('node') ?? process.execPath
    const argv = [...(cfg.runtimeArgs ?? []), program!, ...(cfg.args ?? [])]
    const env: NodeJS.ProcessEnv = { ...process.env, ...(cfg.env ?? {}), ...(useElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }

    if (!debug) {
      terminals.create({ cwd, name: `Run: ${cfg.name}`, initialCommand: [JSON.stringify(exe), ...argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' '), env: useElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : undefined })
      return
    }
    this.setState('starting')
    this.out('info', `$ ${exe} --inspect-brk ${argv.join(' ')}`)
    this.stopOnEntryPending = !!cfg.stopOnEntry
    const child = spawn(exe, ['--inspect-brk=0', ...argv], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout!.on('data', d => this.out('stdout', String(d)))
    let wsUrl: string | null = null
    const gotUrl = new Promise<string>((res, rej) => {
      child.stderr!.on('data', d => {
        const text = String(d)
        const m = text.match(/ws:\/\/[\w.:]+\/[\w-]+/)
        if (m && !wsUrl) { wsUrl = m[0]; res(wsUrl) }
        if (/Waiting for the debugger to disconnect/.test(text)) {
          // the program finished; Node keeps the process alive while an inspector client is connected
          this.out('info', 'The program finished.')
          if (this.child === child) this.cleanup()
          return
        }
        if (!/Debugger listening|For help, see|Debugger attached/.test(text)) this.out('stderr', text)
      })
      child.on('error', e => rej(e))
      child.on('exit', code => { rej(new Error(`The program exited before the debugger attached (code ${code}).`)) })
    })
    child.on('exit', code => { if (this.child !== child) return; this.out('info', `Process exited with code ${code}`); this.cleanup() })
    try { await this.connect(await gotUrl) } catch (e) { this.cleanup(); throw e }
  }

  private async connect(url: string): Promise<void> {
    const WS = (globalThis as any).WebSocket
    if (!WS) throw new Error('WebSocket is not available in this runtime')
    const ws = new WS(url)
    this.ws = ws
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('Could not connect to the debugger')) })
    ws.onmessage = (ev: { data: string }) => this.onMessage(JSON.parse(String(ev.data)))
    ws.onclose = () => { if (this.ws === ws) this.cleanup() }
    await this.cmd('Runtime.enable')
    await this.cmd('Debugger.enable')
    await this.cmd('Debugger.setPauseOnExceptions', { state: this.exceptionMode })
    await this.cmd('Debugger.setAsyncCallStackDepth', { maxDepth: 16 }).catch(() => undefined)
    for (const [path, list] of this.bps) await this.bindPath(path, list)
    this.setState('running')
    await this.cmd('Runtime.runIfWaitingForDebugger')
  }

  private cleanup(): void {
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    if (this.child) { killTree(this.child); this.child = null }
    for (const p of this.pending.values()) p.reject(new Error('debug session ended'))
    this.pending.clear()
    this.frames = []; this.cdpFrames = []
    if (this.state !== 'inactive') this.setState('terminated')
  }

  async stop(): Promise<void> { this.cleanup(); this.state = 'inactive'; emit('debug:state', this.buildSnapshot()) }
  async restart(): Promise<void> { const c = this.config, ctx = this.ctx; if (!c) return; await this.stop(); await this.start(c, true, ctx) }

  private cmd(method: string, params: Cdp = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('Not debugging'))
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private onMessage(msg: Cdp): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
      return
    }
    switch (msg.method) {
      case 'Debugger.scriptParsed': this.onScript(msg.params); break
      case 'Debugger.paused': void this.onPaused(msg.params); break
      case 'Debugger.resumed': this.frames = []; this.cdpFrames = []; if (this.state === 'paused') this.setState('running'); break
      case 'Debugger.breakpointResolved': break
      case 'Runtime.exceptionThrown': this.out('error', (msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? 'Uncaught exception') + '\n'); break
    }
  }

  // ───────────── scripts & breakpoints ─────────────
  private onScript(p: Cdp): void {
    let path: string | null = null
    if (typeof p.url === 'string' && p.url.startsWith('file://')) { try { path = fileURLToPath(p.url) } catch { path = null } }
    let map: SourceMap | null = null
    if (p.sourceMapURL && path) map = loadSourceMapFromUrl(p.sourceMapURL, path, f => { try { return readFileSync(f, 'utf8') } catch { return null } })
    const s: Script = { id: p.scriptId, url: p.url, path, map }
    this.scripts.set(p.scriptId, s)
    if (map) for (const [bpPath, list] of this.bps) if (map.sources.some(src => src.toLowerCase() === bpPath.toLowerCase())) void this.bindMapped(s, bpPath, list)
  }

  private condition(bp: Breakpoint): string | undefined {
    if (bp.logMessage) return '(console.log(`' + bp.logMessage.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '${$1}') + '`), false)'
    return bp.condition || undefined
  }

  private async bindMapped(s: Script, path: string, list: Breakpoint[]): Promise<void> {
    if (!s.map) return
    for (const bp of list.filter(b => b.enabled)) {
      const pos = s.map.generatedPositionFor(path, bp.line - 1)
      if (!pos) continue
      try {
        const r = await this.cmd('Debugger.setBreakpoint', { location: { scriptId: s.id, lineNumber: pos.line, columnNumber: pos.col }, condition: this.condition(bp) })
        this.cdpIds.set(path, [...(this.cdpIds.get(path) ?? []), r.breakpointId])
        bp.verified = true
      } catch { /* script gone */ }
    }
    emit('debug:breakpoints', { path, breakpoints: list })
  }

  private async bindPath(path: string, list: Breakpoint[]): Promise<void> {
    for (const id of this.cdpIds.get(path) ?? []) await this.cmd('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined)
    this.cdpIds.delete(path)
    const urlRegex = escapeRe(pathToFileURL(path).toString()).replace(/^file:\\\/\\\/\\\//, 'file:\\/\\/\\/?') + '$|^' + escapeRe(path).replace(/\\\\/g, '[\\\\/]') + '$'
    for (const bp of list.filter(b => b.enabled)) {
      try {
        const r = await this.cmd('Debugger.setBreakpointByUrl', { lineNumber: bp.line - 1, urlRegex: `^(${urlRegex})`, condition: this.condition(bp) })
        this.cdpIds.set(path, [...(this.cdpIds.get(path) ?? []), r.breakpointId])
        bp.verified = (r.locations?.length ?? 0) > 0 || bp.verified
      } catch { /* not yet loaded */ }
    }
    for (const s of this.scripts.values()) if (s.map?.sources.some(src => src.toLowerCase() === path.toLowerCase())) await this.bindMapped(s, path, list)
  }

  async setBreakpoints(path: string, list: Breakpoint[]): Promise<Breakpoint[]> {
    this.bps.set(path, list.map(b => ({ ...b })))
    if (this.ws) await this.bindPath(path, this.bps.get(path)!)
    return this.bps.get(path)!
  }

  async setExceptionBreakpoints(mode: 'none' | 'uncaught' | 'all'): Promise<void> {
    this.exceptionMode = mode
    if (this.ws) await this.cmd('Debugger.setPauseOnExceptions', { state: mode })
  }

  // ───────────── pausing ─────────────
  private translate(loc: Cdp): { path: string; line: number; col: number } {
    const s = this.scripts.get(loc.scriptId)
    let path = s?.path ?? s?.url ?? ''
    let line = loc.lineNumber, col = loc.columnNumber ?? 0
    if (s?.map) { const o = s.map.originalPositionFor(line, col); if (o) { path = o.source; line = o.line; col = o.col } }
    return { path, line: line + 1, col: col + 1 }
  }

  private async onPaused(p: Cdp): Promise<void> {
    if (p.reason === 'Break on start') {
      // --inspect-brk pauses on the first line; continue unless the configuration asked to stop on entry
      if (!this.stopOnEntryPending) { void this.cmd('Debugger.resume').catch(() => undefined); return }
      this.stopOnEntryPending = false
    }
    this.cdpFrames = p.callFrames ?? []
    this.frames = this.cdpFrames.filter((f: Cdp) => !String(f.url).startsWith('node:')).map((f: Cdp): DebugFrame => {
      const t = this.translate(f.location)
      return {
        id: f.callFrameId, name: f.functionName || '(anonymous)', path: t.path, line: t.line, col: t.col,
        scopes: (f.scopeChain ?? []).map((s: Cdp) => ({ name: s.type[0].toUpperCase() + s.type.slice(1), ref: s.object.objectId, expensive: s.type === 'global' }))
      }
    })
    this.pauseReason = p.reason === 'exception' || p.reason === 'promiseRejection' ? 'exception' : p.hitBreakpoints?.length ? 'breakpoint' : p.reason === 'Break on start' ? 'entry' : 'step'
    this.exception = p.reason === 'exception' ? p.data?.description ?? String(p.data?.value ?? '') : undefined
    this.setState('paused')
  }

  private async ctl(method: string): Promise<void> { if (this.state === 'paused' || method === 'Debugger.pause') await this.cmd(method) }
  async resume() { await this.ctl('Debugger.resume') }
  async pause() { if (this.state === 'running') await this.cmd('Debugger.pause') }
  async stepOver() { await this.ctl('Debugger.stepOver') }
  async stepInto() { await this.ctl('Debugger.stepInto') }
  async stepOut() { await this.ctl('Debugger.stepOut') }

  // ───────────── inspection ─────────────
  async variables(ref: string): Promise<DebugVariable[]> {
    const r = await this.cmd('Runtime.getProperties', { objectId: ref, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false })
    const out: DebugVariable[] = []
    for (const p of r.result ?? []) {
      if (p.symbol) continue
      const f = fmtValue(p.value ?? (p.get ? { type: 'function', description: '(getter)' } : undefined))
      out.push({ name: p.name, value: p.get && !p.value ? '(getter)' : f.value, type: f.type, ref: f.ref, expandable: f.expandable })
    }
    for (const p of r.internalProperties ?? []) { const f = fmtValue(p.value); out.push({ name: `[[${p.name}]]`, value: f.value, type: f.type, ref: f.ref, expandable: f.expandable }) }
    out.sort((a, b) => (/^\d+$/.test(a.name) && /^\d+$/.test(b.name) ? Number(a.name) - Number(b.name) : 0))
    return out
  }

  async evaluate(expr: string, frameId?: string): Promise<{ value: string; type?: string; ref?: string; expandable: boolean; error?: boolean }> {
    if (!this.ws) return { value: 'Not debugging – start a debug session first.', expandable: false, error: true }
    try {
      const r = frameId && this.state === 'paused'
        ? await this.cmd('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: expr, objectGroup: 'console', includeCommandLineAPI: true, silent: true })
        : await this.cmd('Runtime.evaluate', { expression: expr, objectGroup: 'console', includeCommandLineAPI: true, silent: true, awaitPromise: false, replMode: true })
      if (r.exceptionDetails) return { ...fmtValue(r.exceptionDetails.exception), value: (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Error').split('\n')[0], error: true }
      return fmtValue(r.result)
    } catch (e) { return { value: (e as Error).message, expandable: false, error: true } }
  }
}

export const debuggerService = new DebugService()
void log
