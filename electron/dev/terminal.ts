import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { TerminalCreateOptions, TerminalInfo } from '../../shared/dev'
import { emit } from '../services/events'
import { workspace } from '../services/workspace'
import { settings } from '../services/settings'
import { defaultShell, killTree } from '../services/proc'
import { log } from '../services/log'
import { uid } from '../services/storage'

interface PtyLike { pid: number; write(d: string): void; resize(c: number, r: number): void; kill(sig?: string): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void }

interface Term {
  info: TerminalInfo
  pty?: PtyLike
  child?: ChildProcess
  buffer: string
  pending: string
  timer: NodeJS.Timeout | null
  line: string
}

const MAX_BUFFER = 300_000

function loadPty(): { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyLike } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@lydell/node-pty')
  } catch (e) {
    log.warn('terminal', `node-pty unavailable, using basic terminal: ${(e as Error).message}`)
    return null
  }
}

class TerminalService {
  private terms = new Map<string, Term>()
  private counter = 0
  private ptyMod: ReturnType<typeof loadPty> | undefined

  list(): TerminalInfo[] { return [...this.terms.values()].map(t => t.info) }

  create(o: TerminalCreateOptions = {}): TerminalInfo {
    const id = uid('term-')
    const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : workspace.root ?? process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
    const sh = defaultShell(o.shell || settings.get().terminal.shell)
    const args = o.args ?? sh.interactiveArgs
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TGGAGS', LANG: process.env.LANG ?? 'en_US.UTF-8', ...(o.env ?? {}) }
    delete env.ELECTRON_RUN_AS_NODE
    const cols = o.cols ?? 100, rows = o.rows ?? 28
    const name = o.name ?? `${sh.name}${this.counter ? ` ${this.counter + 1}` : ''}`
    this.counter++
    const term: Term = { info: { id, name, shell: sh.path, pid: 0, cwd, pty: false }, buffer: '', pending: '', timer: null, line: '' }

    if (this.ptyMod === undefined) this.ptyMod = loadPty()
    if (this.ptyMod) {
      try {
        const p = this.ptyMod.spawn(sh.path, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true })
        term.pty = p; term.info.pid = p.pid; term.info.pty = true
        p.onData(d => this.data(term, d))
        p.onExit(e => this.exited(term, e.exitCode))
      } catch (e) {
        log.warn('terminal', `PTY spawn failed (${(e as Error).message}); falling back to pipes`)
        this.ptyMod = null
      }
    }
    if (!term.pty) {
      const child = spawn(sh.path, sh.kind === 'powershell' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : sh.kind === 'cmd' ? [] : ['-i'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      term.child = child; term.info.pid = child.pid ?? 0
      child.stdout?.on('data', d => this.data(term, String(d).replace(/\r?\n/g, '\r\n')))
      child.stderr?.on('data', d => this.data(term, String(d).replace(/\r?\n/g, '\r\n')))
      child.on('exit', code => this.exited(term, code ?? 0))
      child.on('error', e => this.data(term, `\r\n[failed to start ${sh.path}: ${e.message}]\r\n`))
      this.data(term, '\x1b[2m(basic terminal – the native PTY module could not be loaded, so interactive programs may not work)\x1b[0m\r\n')
    }
    this.terms.set(id, term)
    emit('terminal:created', term.info)
    if (o.initialCommand) setTimeout(() => this.write(id, o.initialCommand + '\r'), 350)
    return term.info
  }

  private data(t: Term, d: string): void {
    t.buffer += d
    if (t.buffer.length > MAX_BUFFER) t.buffer = t.buffer.slice(t.buffer.length - MAX_BUFFER * 0.8)
    t.pending += d
    if (!t.timer) t.timer = setTimeout(() => { t.timer = null; const chunk = t.pending; t.pending = ''; emit('terminal:data', { id: t.info.id, data: chunk }) }, 8)
  }

  private exited(t: Term, code: number | null): void {
    t.info.exited = code
    emit('terminal:exit', { id: t.info.id, code })
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id)
    if (!t || t.info.exited !== undefined) return
    if (t.pty) { t.pty.write(data); return }
    // Basic mode: no tty, so provide local echo + line editing.
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { this.data(t, '\r\n'); t.child?.stdin?.write(t.line + '\n'); t.line = '' }
      else if (ch === '\x7f' || ch === '\b') { if (t.line) { t.line = t.line.slice(0, -1); this.data(t, '\b \b') } }
      else if (ch === '\x03') { if (t.child) killTree(t.child); this.data(t, '^C\r\n'); t.line = '' }
      else if (ch >= ' ') { t.line += ch; this.data(t, ch) }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    try { t?.pty?.resize(Math.max(2, cols), Math.max(1, rows)) } catch { /* process exited */ }
  }

  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    try { if (t.pty) t.pty.kill(); else if (t.child) killTree(t.child) } catch { /* ignore */ }
    this.terms.delete(id)
    emit('terminal:removed', { id })
  }

  buffer(id: string): string { return this.terms.get(id)?.buffer ?? '' }

  /** Most recent output across terminals (for AI context), ANSI stripped. */
  tail(chars = 8000, id?: string): string {
    const t = id ? this.terms.get(id) : [...this.terms.values()].pop()
    if (!t) return ''
    // eslint-disable-next-line no-control-regex
    return t.buffer.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '').slice(-chars)
  }

  killAll(): void { for (const id of [...this.terms.keys()]) this.kill(id) }
}

export const terminals = new TerminalService()
