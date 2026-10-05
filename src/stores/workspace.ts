import { create } from 'zustand'
import type { FileEntry } from '@shared/fs'
import type { WorkspaceInfo } from '@shared/api'
import { api, onEvent } from '../lib/api'

interface WorkspaceState extends WorkspaceInfo {
  entries: Record<string, FileEntry[]>
  expanded: Record<string, boolean>
  files: string[]
  filesStamp: number
  loading: Record<string, boolean>
  init(): Promise<void>
  open(root: string): Promise<void>
  close(): Promise<void>
  loadDir(dir: string, force?: boolean): Promise<void>
  toggle(dir: string): Promise<void>
  expandTo(path: string): Promise<void>
  collapseAll(): void
  refresh(): Promise<void>
  fileList(force?: boolean): Promise<string[]>
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null, name: '', isGit: false, entries: {}, expanded: {}, files: [], filesStamp: 0, loading: {},
  async init() {
    const info = await api.workspace.info()
    set({ ...info })
    if (info.root) { void get().loadDir(info.root); set(s => ({ expanded: { ...s.expanded, [info.root!]: true } })) }
    onEvent('workspace:changed', w => {
      set({ ...w, entries: {}, expanded: w.root ? { [w.root]: true } : {}, files: [], filesStamp: 0 })
      if (w.root) void get().loadDir(w.root)
    })
    onEvent('fs:changed', ev => {
      const dirs = new Set<string>()
      for (const c of ev.events) { const i = Math.max(c.path.lastIndexOf('/'), c.path.lastIndexOf('\\')); dirs.add(c.path.slice(0, i)); if (c.type === 'addDir' || c.type === 'unlinkDir') dirs.add(c.path) }
      const st = get()
      for (const d of dirs) if (st.entries[d] || d === st.root) void get().loadDir(d, true)
      set({ filesStamp: 0 })
    })
  },
  async open(root) { await api.workspace.open(root) },
  async close() { await api.workspace.close() },
  async loadDir(dir, force) {
    if (!force && get().entries[dir]) return
    if (get().loading[dir]) return
    set(s => ({ loading: { ...s.loading, [dir]: true } }))
    try {
      const list = await api.fs.readDir(dir)
      set(s => ({ entries: { ...s.entries, [dir]: list } }))
    } catch { set(s => { const e = { ...s.entries }; delete e[dir]; return { entries: e } }) }
    finally { set(s => ({ loading: { ...s.loading, [dir]: false } })) }
  },
  async toggle(dir) {
    const open = !get().expanded[dir]
    set(s => ({ expanded: { ...s.expanded, [dir]: open } }))
    if (open) await get().loadDir(dir)
  },
  async expandTo(path) {
    const root = get().root
    if (!root) return
    const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean)
    parts.pop()
    let cur = root
    const exp: Record<string, boolean> = { [root]: true }
    for (const p of parts) { cur = cur + (cur.includes('\\') && !cur.includes('/') ? '\\' : '/') + p; exp[cur] = true; await get().loadDir(cur) }
    set(s => ({ expanded: { ...s.expanded, ...exp } }))
  },
  collapseAll() { const r = get().root; set({ expanded: r ? { [r]: true } : {} }) },
  async refresh() { const st = get(); for (const d of Object.keys(st.entries)) await get().loadDir(d, true) },
  async fileList(force) {
    const st = get()
    if (!force && st.files.length && Date.now() - st.filesStamp < 15_000) return st.files
    const files = await api.fs.listFiles()
    set({ files, filesStamp: Date.now() })
    return files
  }
}))
