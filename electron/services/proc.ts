import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** max captured bytes per stream before truncating the middle */
  maxBuffer?: number
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

export interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  error?: string
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  } catch { /* already gone */ }
}

class Capture {
  private head = ''
  private tail = ''
  private total = 0
  truncated = false
  constructor(private max: number) {}
  push(s: string): void {
    this.total += s.length
    if (!this.truncated) {
      this.head += s
      if (this.head.length > this.max) { this.truncated = true; this.tail = this.head.slice(this.max / 2); this.head = this.head.slice(0, this.max / 2) }
    } else {
      this.tail += s
      if (this.tail.length > this.max / 2) this.tail = this.tail.slice(this.tail.length - this.max / 2)
    }
  }
  toString(): string {
    return this.truncated ? `${this.head}\n\n… [${this.total - this.head.length - this.tail.length} characters truncated] …\n\n${this.tail}` : this.head
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const out = new Capture(opts.maxBuffer ?? 400_000)
    const err = new Capture(opts.maxBuffer ?? 400_000)
    let timedOut = false, aborted = false, settled = false
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
      })
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: (e as Error).message })
      return
    }
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, signal, stdout: out.toString(), stderr: err.toString(), timedOut, aborted, truncated: out.truncated || err.truncated, error })
    }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(child) }, opts.timeoutMs) : undefined
    const onAbort = () => { aborted = true; killTree(child) }
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true }) }
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { out.push(d); opts.onData?.(d, 'stdout') })
    child.stderr?.on('data', (d: string) => { err.push(d); opts.onData?.(d, 'stderr') })
    child.on('error', e => finish(null, null, e.message))
    child.on('close', (code, signal) => finish(code, signal))
    if (opts.input !== undefined && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(opts.input) }
  })
}

const winExts = () => (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(s => s.toLowerCase())

export function which(cmd: string): string | null {
  const paths = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['', ...winExts()] : ['']
  for (const p of paths) for (const ext of exts) {
    const full = join(p, cmd + ext)
    if (existsSync(full)) return full
  }
  return null
}

export interface ShellSpec { path: string; name: string; kind: 'powershell' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'fish'; args: (command: string) => string[]; interactiveArgs: string[] }

export function defaultShell(preferred?: string): ShellSpec {
  const pick = (path: string): ShellSpec => {
    const lower = path.toLowerCase()
    if (/pwsh|powershell/.test(lower)) {
      return { path, name: /pwsh/.test(lower) ? 'PowerShell 7' : 'Windows PowerShell', kind: 'powershell', interactiveArgs: ['-NoLogo'],
        args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${c}`] }
    }
    if (/cmd(\.exe)?$/.test(lower)) return { path, name: 'Command Prompt', kind: 'cmd', interactiveArgs: [], args: c => ['/d', '/s', '/c', c] }
    const base = lower.split(/[\\/]/).pop() ?? ''
    const kind = base.includes('zsh') ? 'zsh' : base.includes('fish') ? 'fish' : base.includes('bash') ? 'bash' : 'sh'
    return { path, name: base.replace(/\.exe$/, ''), kind, interactiveArgs: kind === 'bash' || kind === 'zsh' ? ['-l'] : [], args: c => ['-c', c] }
  }
  if (preferred && existsSync(preferred)) return pick(preferred)
  if (preferred) { const w = which(preferred); if (w) return pick(w) }
  if (process.platform === 'win32') {
    const pwsh = which('pwsh')
    if (pwsh) return pick(pwsh)
    const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return pick(existsSync(sys) ? sys : 'powershell.exe')
  }
  const sh = process.env.SHELL
  if (sh && existsSync(sh)) return pick(sh)
  return pick(existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
}
