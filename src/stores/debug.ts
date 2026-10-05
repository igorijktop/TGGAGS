import { create } from 'zustand'
import type { Breakpoint, DebugSnapshot, LaunchConfig } from '@shared/dev'
import { api, onEvent } from '../lib/api'
import { uid } from '../lib/util'

export interface ConsoleLine { id: string; kind: 'stdout' | 'stderr' | 'info' | 'error' | 'input' | 'result'; text: string }
interface DebugStore {
  snapshot: DebugSnapshot
  breakpoints: Record<string, Breakpoint[]>
  console: ConsoleLine[]
  configs: LaunchConfig[]
  selectedConfig: string
  frameId: string | null
  exceptionMode: 'none' | 'uncaught' | 'all'
  watches: string[]
  loadConfigs(): Promise<void>
  toggleBreakpoint(path: string, line: number): Promise<void>
  editBreakpoint(path: string, line: number, patch: Partial<Breakpoint>): Promise<void>
  removeBreakpoint(path: string, line: number): Promise<void>
  clearBreakpoints(): Promise<void>
  addLine(kind: ConsoleLine['kind'], text: string): void
  selectFrame(id: string | null): void
  setWatches(w: string[]): void
}

export const useDebug = create<DebugStore>((set, get) => ({
  snapshot: { state: 'inactive', frames: [] }, breakpoints: {}, console: [], configs: [], selectedConfig: '', frameId: null, exceptionMode: 'uncaught', watches: [],
  async loadConfigs() { const configs = await api.debug.loadConfigs().catch(() => []); set(s => ({ configs, selectedConfig: configs.some(c => c.name === s.selectedConfig) ? s.selectedConfig : configs[0]?.name ?? '' })) },
  async toggleBreakpoint(path, line) {
    const list = get().breakpoints[path] ?? []
    const next = list.some(b => b.line === line) ? list.filter(b => b.line !== line) : [...list, { id: uid('bp-'), path, line, enabled: true }]
    set(s => ({ breakpoints: { ...s.breakpoints, [path]: next } }))
    set(s => ({ breakpoints: { ...s.breakpoints, [path]: next } }))
    const res = await api.debug.setBreakpoints(path, next).catch(() => next)
    set(s => ({ breakpoints: { ...s.breakpoints, [path]: res } }))
  },
  async editBreakpoint(path, line, patch) {
    const next = (get().breakpoints[path] ?? []).map(b => b.line === line ? { ...b, ...patch } : b)
    set(s => ({ breakpoints: { ...s.breakpoints, [path]: next } }))
    await api.debug.setBreakpoints(path, next).catch(() => undefined)
  },
  async removeBreakpoint(path, line) {
    const next = (get().breakpoints[path] ?? []).filter(b => b.line !== line)
    set(s => ({ breakpoints: { ...s.breakpoints, [path]: next } }))
    await api.debug.setBreakpoints(path, next).catch(() => undefined)
  },
  async clearBreakpoints() { const paths = Object.keys(get().breakpoints); set({ breakpoints: {} }); for (const p of paths) await api.debug.setBreakpoints(p, []).catch(() => undefined) },
  addLine(kind, text) { set(s => ({ console: [...s.console, { id: uid('l-'), kind, text }].slice(-1500) })) },
  selectFrame(id) { set({ frameId: id }) },
  setWatches(w) { set({ watches: w }) }
}))

export function initDebug(): void {
  onEvent('debug:state', snap => {
    useDebug.setState(s => ({ snapshot: snap, frameId: snap.state === 'paused' ? snap.frames[0]?.id ?? null : null, console: snap.state === 'starting' && s.snapshot.state !== 'starting' ? [] : s.console }))
  })
  onEvent('debug:output', o => { for (const part of o.text.replace(/\r\n/g, '\n').split('\n')) if (part !== '') useDebug.getState().addLine(o.category, part) })
  onEvent('debug:breakpoints', ({ path, breakpoints }) => useDebug.setState(s => ({ breakpoints: { ...s.breakpoints, [path]: breakpoints } })))
  void useDebug.getState().loadConfigs()
  void api.debug.snapshot().then(snapshot => useDebug.setState({ snapshot }))
}
