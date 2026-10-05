import { isMac } from './api'

export interface Command {
  id: string
  title: string
  category?: string
  /** default keybinding, e.g. "Mod+Shift+P" or a chord "Mod+K Mod+S" */
  keybinding?: string
  run(arg?: unknown): void | Promise<void>
  enabled?(): boolean
  /** hide from the command palette */
  hidden?: boolean
}

const registry = new Map<string, Command>()
let userBindings: Record<string, string> = {}

export function registerCommands(list: Command[]): void { for (const c of list) registry.set(c.id, c) }
export function getCommand(id: string): Command | undefined { return registry.get(id) }
export function allCommands(): Command[] { return [...registry.values()] }
export function setUserKeybindings(b: Record<string, string>): void { userBindings = b }
export function keybindingFor(id: string): string | undefined { const u = userBindings[id]; return u === '' ? undefined : (u ?? registry.get(id)?.keybinding) }

export async function runCommand(id: string, arg?: unknown): Promise<void> {
  const c = registry.get(id)
  if (!c) { console.warn('unknown command', id); return }
  if (c.enabled && !c.enabled()) return
  try { await c.run(arg) } catch (e) { console.error(`command ${id} failed`, e) }
}

// ───────────── key parsing ─────────────
const CODE: Record<string, string> = { '`': 'Backquote', '\\': 'Backslash', ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', ';': 'Semicolon', "'": 'Quote', space: 'Space', enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert' }

interface Chord { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; code: string }

function parseChord(s: string): Chord {
  const c: Chord = { ctrl: false, shift: false, alt: false, meta: false, code: '' }
  for (const raw of s.split('+')) {
    const p = raw.trim()
    const l = p.toLowerCase()
    if (l === 'mod') { if (isMac) c.meta = true; else c.ctrl = true }
    else if (l === 'ctrl' || l === 'control') c.ctrl = true
    else if (l === 'shift') c.shift = true
    else if (l === 'alt' || l === 'option') c.alt = true
    else if (l === 'meta' || l === 'cmd' || l === 'win') c.meta = true
    else c.code = CODE[l] ?? (/^f\d{1,2}$/i.test(p) ? p.toUpperCase() : /^[a-z]$/i.test(p) ? `Key${p.toUpperCase()}` : /^\d$/.test(p) ? `Digit${p}` : p)
  }
  return c
}
const parsedCache = new Map<string, Chord[]>()
const parse = (kb: string) => { let p = parsedCache.get(kb); if (!p) { p = kb.split(/\s+/).map(parseChord); parsedCache.set(kb, p) } return p }
const matches = (e: KeyboardEvent, c: Chord) => e.code === c.code && e.ctrlKey === c.ctrl && e.shiftKey === c.shift && e.altKey === c.alt && e.metaKey === c.meta

export function formatKeybinding(kb: string): string {
  return kb.split(/\s+/).map(part => part.split('+').map(p => {
    const l = p.toLowerCase()
    if (l === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (l === 'alt') return isMac ? '⌥' : 'Alt'
    if (l === 'shift') return isMac ? '⇧' : 'Shift'
    if (l === 'meta' || l === 'cmd') return isMac ? '⌘' : 'Win'
    if (l === 'ctrl') return isMac ? '⌃' : 'Ctrl'
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)
  }).join(isMac ? '' : '+')).join(' ')
}

/** Converts a KeyboardEvent to our binding string (for the "record shortcut" UI). */
export function eventToBinding(e: KeyboardEvent): string | null {
  if (['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return null
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  else if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey && !isMac) parts.push('Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const rev = Object.entries(CODE).find(([k, v]) => v === e.code && k.length > 1)?.[0] ?? Object.entries(CODE).find(([, v]) => v === e.code)?.[0]
  const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : rev ?? e.code
  parts.push(key.length === 1 ? key : key[0].toUpperCase() + key.slice(1))
  return parts.join('+')
}

export function installKeybindings(): () => void {
  let pending: { chords: Chord[]; idx: number } | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  const handler = (e: KeyboardEvent) => {
    if (e.isComposing || e.repeat && !/^F\d/.test(e.code) && false) return
    const all = [...registry.values()]
    const candidates: { cmd: Command; chords: Chord[] }[] = []
    for (const cmd of all) { const kb = keybindingFor(cmd.id); if (kb) candidates.push({ cmd, chords: parse(kb) }) }
    if (pending) {
      const idx = pending.idx
      const hit = candidates.find(c => c.chords.length > idx && c.chords.slice(0, idx).every((ch, i) => ch === pending!.chords[i] || JSON.stringify(ch) === JSON.stringify(pending!.chords[i])) && matches(e, c.chords[idx]))
      pending = null; if (pendingTimer) clearTimeout(pendingTimer)
      if (hit && hit.chords.length === idx + 1) { e.preventDefault(); e.stopPropagation(); void runCommand(hit.cmd.id); return }
      if (hit) { pending = { chords: hit.chords, idx: idx + 1 }; e.preventDefault(); return }
    }
    for (const c of candidates) {
      if (!matches(e, c.chords[0])) continue
      if (c.cmd.enabled && !c.cmd.enabled()) continue
      e.preventDefault(); e.stopPropagation()
      if (c.chords.length > 1) { pending = { chords: c.chords, idx: 1 }; pendingTimer = setTimeout(() => { pending = null }, 1500) }
      else void runCommand(c.cmd.id)
      return
    }
  }
  window.addEventListener('keydown', handler, true)
  return () => window.removeEventListener('keydown', handler, true)
}
