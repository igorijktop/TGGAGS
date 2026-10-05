import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../../services/proc'

interface Bg { id: string; command: string; child: ChildProcess; output: string; readUpTo: number; startedAt: number; exit?: number | null; cwd: string }
const procs = new Map<string, Bg>()
let seq = 0

export function startBackground(shell: { path: string; args: string[] }, command: string, cwd: string, env: NodeJS.ProcessEnv): Bg {
  const child = spawn(shell.path, shell.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const bg: Bg = { id: `bg_${++seq}`, command, child, output: '', readUpTo: 0, startedAt: Date.now(), cwd }
  const add = (d: Buffer | string) => { bg.output += d.toString(); if (bg.output.length > 400_000) { const cut = bg.output.length - 300_000; bg.output = bg.output.slice(cut); bg.readUpTo = Math.max(0, bg.readUpTo - cut) } }
  child.stdout?.on('data', add); child.stderr?.on('data', add)
  child.on('close', code => { bg.exit = code })
  child.on('error', e => { bg.output += `\n[spawn error: ${e.message}]`; bg.exit = -1 })
  procs.set(bg.id, bg)
  return bg
}

export function readBackground(id: string, all = false): { text: string; running: boolean; exit?: number | null; command: string } | null {
  const bg = procs.get(id)
  if (!bg) return null
  const text = all ? bg.output : bg.output.slice(bg.readUpTo)
  bg.readUpTo = bg.output.length
  return { text, running: bg.exit === undefined, exit: bg.exit, command: bg.command }
}

export function killBackground(id: string): boolean {
  const bg = procs.get(id)
  if (!bg) return false
  if (bg.exit === undefined) killTree(bg.child)
  return true
}

export function listBackground(): { id: string; command: string; running: boolean; startedAt: number }[] {
  return [...procs.values()].map(b => ({ id: b.id, command: b.command, running: b.exit === undefined, startedAt: b.startedAt }))
}

export function killAllBackground(): void { for (const b of procs.values()) if (b.exit === undefined) killTree(b.child) }
