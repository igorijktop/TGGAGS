import { create } from 'zustand'
import type { TerminalInfo } from '@shared/dev'
import { api, onEvent } from '../lib/api'
import { useUi } from './ui'

interface TermState {
  terminals: TerminalInfo[]
  active: string | null
  create(opts?: { cwd?: string; name?: string; initialCommand?: string; show?: boolean }): Promise<TerminalInfo>
  kill(id: string): Promise<void>
  select(id: string): void
  /** make sure at least one terminal exists (concurrent callers share one creation) */
  ensure(): Promise<void>
  runCommand(command: string, name?: string): Promise<void>
}

let ensuring: Promise<void> | null = null

export const useTerminals = create<TermState>((set, get) => ({
  terminals: [], active: null,
  ensure() { if (get().terminals.length) return Promise.resolve(); ensuring ??= get().create({ show: false }).then(() => undefined).finally(() => { ensuring = null }); return ensuring },
  async create(o = {}) {
    const info = await api.terminal.create({ cwd: o.cwd, name: o.name, initialCommand: o.initialCommand })
    set(s => ({ terminals: s.terminals.some(t => t.id === info.id) ? s.terminals : [...s.terminals, info], active: info.id }))
    if (o.show !== false) useUi.getState().set({ panelVisible: true, panelTab: 'terminal' })
    return info
  },
  async kill(id) {
    await api.terminal.kill(id)
    set(s => { const terminals = s.terminals.filter(t => t.id !== id); return { terminals, active: s.active === id ? terminals[terminals.length - 1]?.id ?? null : s.active } })
  },
  select(id) { set({ active: id }) },
  async runCommand(command, name) { await get().create({ initialCommand: command, name: name ?? command.slice(0, 24) }) }
}))

export function initTerminals(): void {
  void api.terminal.list().then(list => useTerminals.setState(s => ({ terminals: list, active: s.active ?? list[0]?.id ?? null })))
  onEvent('terminal:removed', ({ id }) => useTerminals.setState(s => { const terminals = s.terminals.filter(t => t.id !== id); return { terminals, active: s.active === id ? terminals[terminals.length - 1]?.id ?? null : s.active } }))
  onEvent('terminal:created', info => useTerminals.setState(s => s.terminals.some(t => t.id === info.id) ? s : { terminals: [...s.terminals, info], active: s.active ?? info.id }))
  onEvent('terminal:exit', ({ id, code }) => useTerminals.setState(s => ({ terminals: s.terminals.map(t => t.id === id ? { ...t, exited: code ?? 0 } : t) })))
}
