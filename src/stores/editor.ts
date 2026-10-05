import { create } from 'zustand'
import { createElement } from 'react'
import { api } from '../lib/api'
import { basename, extname, uid } from '../lib/util'
import { closeDoc, dirtyPaths, openDoc, saveDoc, useDocs } from '../lib/docs'
import { IMAGE_EXT } from '@shared/languages'
import { dialogs, toast } from './ui'
import { useWorkspace } from './workspace'
import { Button } from '../components/ui'

export type PageId = 'home' | 'settings' | 'models' | 'agents' | 'images' | 'bench' | 'extension' | 'changes' | 'github-pr' | 'commit'
export type TabKind = 'file' | 'diff' | 'image' | 'media' | 'page' | 'binary' | 'preview'

export interface DiffSpec {
  mode: 'staged' | 'unstaged' | 'commit' | 'agent' | 'stash'
  path: string
  commit?: string
  original?: string
  modified?: string
  originalLabel?: string
  modifiedLabel?: string
  readOnly?: boolean
  sessionId?: string
  status?: string
}

export interface Tab {
  id: string
  kind: TabKind
  path?: string
  title: string
  subtitle?: string
  preview: boolean
  pinned: boolean
  page?: PageId
  diff?: DiffSpec
  data?: Record<string, unknown>
  /** reveal request (consumed by the editor) */
  reveal?: { line: number; col: number; n: number }
  note?: string
}
export interface Group { id: string; tabs: Tab[]; activeId: string | null }
export type LayoutNode = { type: 'leaf'; groupId: string } | { type: 'split'; id: string; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] }

export interface EditorStatus { path: string | null; line: number; col: number; selected: number; selLines: number; language: string; eol: 'LF' | 'CRLF'; encoding: string; tabSize: number; insertSpaces: boolean }

interface EditorState {
  groups: Record<string, Group>
  layout: LayoutNode
  activeGroup: string
  closed: Tab[]
  history: { groupId: string; tabId: string }[]
  historyIdx: number
  status: EditorStatus
  openFile(path: string, o?: { line?: number; col?: number; preview?: boolean; group?: string; focus?: boolean; pin?: boolean }): Promise<void>
  openPage(page: PageId, data?: Record<string, unknown>, title?: string): void
  openDiff(spec: DiffSpec): void
  activate(groupId: string, tabId: string): void
  focusGroup(groupId: string): void
  closeTab(groupId: string, tabId: string, force?: boolean): Promise<boolean>
  closeMany(groupId: string, ids: string[]): Promise<void>
  closeAll(): Promise<void>
  pinTab(groupId: string, tabId: string, pin: boolean): void
  keepOpen(groupId: string, tabId: string): void
  moveTab(fromGroup: string, tabId: string, toGroup: string, index?: number): void
  split(dir: 'row' | 'col', groupId?: string): void
  setSizes(nodeId: string, sizes: number[]): void
  reopenClosed(): void
  navigate(delta: -1 | 1): void
  setStatus(p: Partial<EditorStatus>): void
  activeTab(): Tab | null
  tabsForPath(path: string): { group: Group; tab: Tab }[]
  renamePath(from: string, to: string): void
  removePath(path: string): void
  reset(): void
  restore(): Promise<void>
}

const newGroup = (): Group => ({ id: uid('g-'), tabs: [], activeId: null })
const first = newGroup()
const initialStatus: EditorStatus = { path: null, line: 1, col: 1, selected: 0, selLines: 0, language: 'plaintext', eol: 'LF', encoding: 'UTF-8', tabSize: 2, insertSpaces: true }

function mapLeaf(node: LayoutNode, groupId: string, fn: (leaf: LayoutNode) => LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node.groupId === groupId ? fn(node) : node
  return { ...node, children: node.children.map(c => mapLeaf(c, groupId, fn)) }
}

function removeLeaf(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.type === 'leaf') return node.groupId === groupId ? null : node
  const kids = node.children.map(c => removeLeaf(c, groupId))
  const keep: LayoutNode[] = [], sizes: number[] = []
  kids.forEach((k, i) => { if (k) { keep.push(k); sizes.push(node.sizes[i] ?? 1) } })
  if (!keep.length) return null
  if (keep.length === 1) return keep[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children: keep, sizes: sizes.map(s => s / total) }
}

function leafIds(node: LayoutNode): string[] { return node.type === 'leaf' ? [node.groupId] : node.children.flatMap(leafIds) }

async function promptSave(names: string[]): Promise<'save' | 'discard' | 'cancel'> {
  const r = await dialogs.custom<'save' | 'discard' | 'cancel'>({
    title: names.length === 1 ? `Save changes to ${names[0]}?` : `Save changes to ${names.length} files?`,
    render: close => createElement('div', null,
      createElement('p', { style: { margin: '0 0 16px', color: 'var(--fg-muted)' } }, names.length === 1 ? "Your changes will be lost if you don't save them." : names.join(', ')),
      createElement('div', { className: 'row gap8', style: { justifyContent: 'flex-end' } },
        createElement(Button, { variant: 'ghost', onClick: () => close('cancel') }, 'Cancel'),
        createElement(Button, { variant: 'secondary', onClick: () => close('discard') }, "Don't save"),
        createElement(Button, { variant: 'primary', autoFocus: true, onClick: () => close('save') }, 'Save')))
  })
  return r ?? 'cancel'
}

const IMAGE_SET = IMAGE_EXT
const MEDIA = new Set(['mp4', 'webm', 'mp3', 'wav', 'ogg', 'pdf'])

export const useEditor = create<EditorState>((set, get) => {
  const pushHistory = (groupId: string, tabId: string) => {
    const s = get()
    const cur = s.history[s.historyIdx]
    if (cur && cur.groupId === groupId && cur.tabId === tabId) return
    const h = [...s.history.slice(0, s.historyIdx + 1), { groupId, tabId }].slice(-60)
    set({ history: h, historyIdx: h.length - 1 })
  }
  const place = (tab: Tab, groupId?: string): void => {
    const s = get()
    const gid = groupId ?? s.activeGroup
    const g = s.groups[gid] ?? Object.values(s.groups)[0]
    let tabs = g.tabs
    if (tab.preview) tabs = tabs.filter(t => !t.preview)
    const idx = tab.preview ? Math.max(0, tabs.findIndex(t => !t.pinned)) : tabs.length
    const pinnedCount = tabs.filter(t => t.pinned).length
    const at = tab.preview ? Math.max(idx, pinnedCount) : Math.max(tabs.length, pinnedCount)
    tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)]
    set({ groups: { ...s.groups, [g.id]: { ...g, tabs, activeId: tab.id } }, activeGroup: g.id })
    pushHistory(g.id, tab.id)
  }

  return {
    groups: { [first.id]: first }, layout: { type: 'leaf', groupId: first.id }, activeGroup: first.id, closed: [], history: [], historyIdx: -1, status: initialStatus,

    async openFile(path, o = {}) {
      const s = get()
      const existing = s.tabsForPath(path)
      const reveal = o.line ? { line: o.line, col: o.col ?? 1, n: Date.now() } : undefined
      if (existing.length) {
        const hit = existing.find(e => e.group.id === (o.group ?? s.activeGroup)) ?? existing[0]
        set(st => ({
          groups: { ...st.groups, [hit.group.id]: { ...hit.group, activeId: hit.tab.id, tabs: hit.group.tabs.map(t => t.id === hit.tab.id ? { ...t, reveal: reveal ?? t.reveal, preview: o.pin || !o.preview ? false : t.preview } : t) } },
          activeGroup: hit.group.id
        }))
        pushHistory(hit.group.id, hit.tab.id)
        return
      }
      const ext = extname(path)
      let tab: Tab
      if (IMAGE_SET.has(ext) && ext !== 'svg') tab = { id: path, kind: 'image', path, title: basename(path), preview: !!o.preview, pinned: false }
      else if (MEDIA.has(ext)) tab = { id: path, kind: 'media', path, title: basename(path), preview: !!o.preview, pinned: false }
      else {
        let r
        try { r = await openDoc(path) } catch (e) { toast.error(`Could not open ${basename(path)}: ${(e as Error).message}`); return }
        if (r.kind === 'text') tab = { id: path, kind: 'file', path, title: basename(path), preview: !!o.preview && !o.pin, pinned: false, reveal }
        else tab = { id: path, kind: 'binary', path, title: basename(path), preview: !!o.preview, pinned: false, note: r.kind === 'tooLarge' ? 'This file is too large to open in the editor.' : `Binary file${r.mime ? ` (${r.mime})` : ''} – it can't be shown as text.` }
      }
      place(tab, o.group)
      void useWorkspace.getState().expandTo(path)
      persist()
    },

    openPage(page, data, title) {
      const id = `page:${page}${data?.key ? ':' + String(data.key) : ''}`
      const s = get()
      for (const g of Object.values(s.groups)) {
        const t = g.tabs.find(x => x.id === id)
        if (t) { set({ groups: { ...s.groups, [g.id]: { ...g, activeId: id, tabs: g.tabs.map(x => x.id === id ? { ...x, data: { ...x.data, ...data } } : x) } }, activeGroup: g.id }); pushHistory(g.id, id); return }
      }
      const titles: Record<PageId, string> = { home: 'Home', settings: 'Settings', models: 'Models', agents: 'Agents', images: 'Image Studio', bench: 'Benchmarks', extension: 'Extension', changes: 'Changes', 'github-pr': 'Pull request', commit: 'Commit' }
      place({ id, kind: 'page', page, title: title ?? titles[page], preview: false, pinned: false, data })
    },

    openDiff(spec) {
      const id = `diff:${spec.mode}:${spec.sessionId ?? ''}:${spec.commit ?? ''}:${spec.path}`
      const s = get()
      for (const g of Object.values(s.groups)) {
        const t = g.tabs.find(x => x.id === id)
        if (t) { set({ groups: { ...s.groups, [g.id]: { ...g, activeId: id, tabs: g.tabs.map(x => x.id === id ? { ...x, diff: spec } : x) } }, activeGroup: g.id }); return }
      }
      const label = spec.mode === 'commit' ? `${basename(spec.path)} @ ${spec.commit?.slice(0, 7)}` : spec.mode === 'agent' ? `${basename(spec.path)} (AI changes)` : `${basename(spec.path)} ${spec.mode === 'staged' ? '(Staged)' : '(Changes)'}`
      place({ id, kind: 'diff', path: spec.path, title: label, preview: spec.mode !== 'agent', pinned: false, diff: spec })
    },

    activate(groupId, tabId) {
      const s = get()
      const g = s.groups[groupId]
      if (!g) return
      set({ groups: { ...s.groups, [groupId]: { ...g, activeId: tabId } }, activeGroup: groupId })
      pushHistory(groupId, tabId)
      persist()
    },
    focusGroup(groupId) { if (get().groups[groupId]) set({ activeGroup: groupId }) },

    async closeTab(groupId, tabId, force) {
      const s = get()
      const g = s.groups[groupId]
      const tab = g?.tabs.find(t => t.id === tabId)
      if (!g || !tab) return true
      const stillOpenElsewhere = Object.values(s.groups).some(o => o.id !== groupId && o.tabs.some(t => t.id === tabId))
      if (tab.kind === 'file' && tab.path && !force && !stillOpenElsewhere && useDocs.getState().dirty[tab.path]) {
        const r = await promptSave([tab.title])
        if (r === 'cancel') return false
        if (r === 'save') { try { await saveDoc(tab.path) } catch (e) { toast.error(`Save failed: ${(e as Error).message}`); return false } }
      }
      const cur = get()
      const grp = cur.groups[groupId]
      if (!grp) return true
      const idx = grp.tabs.findIndex(t => t.id === tabId)
      const tabs = grp.tabs.filter(t => t.id !== tabId)
      let activeId = grp.activeId
      if (activeId === tabId) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
      const groups = { ...cur.groups, [groupId]: { ...grp, tabs, activeId } }
      let layout = cur.layout
      let activeGroup = cur.activeGroup
      if (!tabs.length && Object.keys(groups).length > 1) {
        delete groups[groupId]
        layout = removeLeaf(layout, groupId) ?? { type: 'leaf', groupId: Object.keys(groups)[0] }
        if (activeGroup === groupId) activeGroup = leafIds(layout)[0]
      }
      set({ groups, layout, activeGroup, closed: tab.kind === 'file' || tab.kind === 'image' ? [tab, ...cur.closed].slice(0, 20) : cur.closed })
      if (tab.kind === 'file' && tab.path && !stillOpenElsewhere) closeDoc(tab.path)
      persist()
      return true
    },

    async closeMany(groupId, ids) {
      const g = get().groups[groupId]
      if (!g) return
      const files = g.tabs.filter(t => ids.includes(t.id) && t.kind === 'file' && t.path && useDocs.getState().dirty[t.path!])
      if (files.length > 1) {
        const r = await promptSave(files.map(f => f.title))
        if (r === 'cancel') return
        if (r === 'save') for (const f of files) { try { await saveDoc(f.path!) } catch { return } }
        for (const id of ids) await get().closeTab(groupId, id, true)
        return
      }
      for (const id of ids) if (!(await get().closeTab(groupId, id))) return
    },

    async closeAll() { for (const g of Object.values(get().groups)) await get().closeMany(g.id, g.tabs.filter(t => !t.pinned).map(t => t.id)) },

    pinTab(groupId, tabId, pin) {
      const s = get(); const g = s.groups[groupId]
      if (!g) return
      const tab = g.tabs.find(t => t.id === tabId)
      if (!tab) return
      const rest = g.tabs.filter(t => t.id !== tabId)
      const pinned = rest.filter(t => t.pinned)
      const next = pin ? [...pinned, { ...tab, pinned: true, preview: false }, ...rest.filter(t => !t.pinned)] : [...pinned, { ...tab, pinned: false }, ...rest.filter(t => !t.pinned)]
      set({ groups: { ...s.groups, [groupId]: { ...g, tabs: next } } })
    },
    keepOpen(groupId, tabId) {
      const s = get(); const g = s.groups[groupId]
      if (!g?.tabs.some(t => t.id === tabId && t.preview)) return
      set({ groups: { ...s.groups, [groupId]: { ...g, tabs: g.tabs.map(t => t.id === tabId ? { ...t, preview: false } : t) } } })
    },

    moveTab(fromGroup, tabId, toGroup, index) {
      const s = get()
      const from = s.groups[fromGroup], to = s.groups[toGroup]
      const tab = from?.tabs.find(t => t.id === tabId)
      if (!from || !to || !tab) return
      if (fromGroup === toGroup) {
        const tabs = from.tabs.filter(t => t.id !== tabId)
        const at = Math.min(index ?? tabs.length, tabs.length)
        tabs.splice(at, 0, { ...tab, preview: false })
        set({ groups: { ...s.groups, [fromGroup]: { ...from, tabs, activeId: tabId } }, activeGroup: fromGroup })
        return
      }
      const dup = to.tabs.find(t => t.id === tabId)
      const fromTabs = from.tabs.filter(t => t.id !== tabId)
      const toTabs = dup ? to.tabs : [...to.tabs.slice(0, index ?? to.tabs.length), { ...tab, preview: false }, ...to.tabs.slice(index ?? to.tabs.length)]
      const groups = { ...s.groups, [fromGroup]: { ...from, tabs: fromTabs, activeId: from.activeId === tabId ? fromTabs[0]?.id ?? null : from.activeId }, [toGroup]: { ...to, tabs: toTabs, activeId: tabId } }
      let layout = s.layout
      if (!fromTabs.length && Object.keys(groups).length > 1) { delete groups[fromGroup]; layout = removeLeaf(layout, fromGroup) ?? layout }
      set({ groups, layout, activeGroup: toGroup })
    },

    split(dir, groupId) {
      const s = get()
      const gid = groupId ?? s.activeGroup
      const g = s.groups[gid]
      if (!g) return
      const active = g.tabs.find(t => t.id === g.activeId)
      const ng = newGroup()
      if (active) { ng.tabs = [{ ...active, preview: false, pinned: false }]; ng.activeId = active.id }
      const leaf: LayoutNode = { type: 'leaf', groupId: ng.id }
      const layout = mapLeaf(s.layout, gid, l => ({ type: 'split', id: uid('s-'), dir, children: [l, leaf], sizes: [0.5, 0.5] }))
      // flatten when the parent already splits in the same direction
      set({ groups: { ...s.groups, [ng.id]: ng }, layout: flatten(layout), activeGroup: ng.id })
    },

    setSizes(nodeId, sizes) {
      const patch = (n: LayoutNode): LayoutNode => n.type === 'leaf' ? n : n.id === nodeId ? { ...n, sizes } : { ...n, children: n.children.map(patch) }
      set({ layout: patch(get().layout) })
    },

    reopenClosed() {
      const t = get().closed[0]
      if (!t) return
      set({ closed: get().closed.slice(1) })
      if (t.path) void get().openFile(t.path, { pin: true })
    },

    navigate(delta) {
      const s = get()
      const idx = s.historyIdx + delta
      const h = s.history[idx]
      if (!h) return
      const g = s.groups[h.groupId]
      if (!g?.tabs.some(t => t.id === h.tabId)) { set({ historyIdx: idx }); get().navigate(delta); return }
      set({ historyIdx: idx, activeGroup: h.groupId, groups: { ...s.groups, [h.groupId]: { ...g, activeId: h.tabId } } })
    },

    setStatus(p) { set({ status: { ...get().status, ...p } }) },
    activeTab() { const s = get(); const g = s.groups[s.activeGroup]; return g?.tabs.find(t => t.id === g.activeId) ?? null },
    tabsForPath(path) {
      const out: { group: Group; tab: Tab }[] = []
      for (const g of Object.values(get().groups)) for (const t of g.tabs) if (t.path === path && t.kind !== 'diff') out.push({ group: g, tab: t })
      return out
    },
    renamePath(from, to) {
      const s = get()
      const groups: Record<string, Group> = {}
      for (const g of Object.values(s.groups)) groups[g.id] = { ...g, activeId: g.activeId === from ? to : g.activeId, tabs: g.tabs.map(t => t.path === from ? { ...t, id: to, path: to, title: basename(to) } : t) }
      set({ groups })
      closeDoc(from)
      void get().openFile(to, { pin: true })
    },
    removePath(path) {
      for (const g of Object.values(get().groups)) for (const t of g.tabs) if (t.path === path || t.path?.startsWith(path + '/') || t.path?.startsWith(path + '\\')) void get().closeTab(g.id, t.id, true)
    },
    reset() {
      const g = newGroup()
      for (const p of Object.keys(useDocs.getState().dirty)) closeDoc(p)
      set({ groups: { [g.id]: g }, layout: { type: 'leaf', groupId: g.id }, activeGroup: g.id, closed: [], history: [], historyIdx: -1, status: initialStatus })
    },
    async restore() {
      const root = useWorkspace.getState().root
      if (!root) return
      try {
        const raw = localStorage.getItem('tabs:' + root)
        if (!raw) return
        const { paths, active } = JSON.parse(raw) as { paths: string[]; active?: string }
        for (const p of paths.slice(0, 12)) { const st = await api.fs.stat(p); if (st.exists) await get().openFile(p, { pin: true }) }
        if (active) { const g = get().groups[get().activeGroup]; if (g.tabs.some(t => t.id === active)) get().activate(g.id, active) }
      } catch { /* ignore */ }
    }
  }
})

function flatten(n: LayoutNode): LayoutNode {
  if (n.type === 'leaf') return n
  const kids: LayoutNode[] = [], sizes: number[] = []
  n.children.forEach((c, i) => {
    const f = flatten(c)
    if (f.type === 'split' && f.dir === n.dir) { f.children.forEach((fc, j) => { kids.push(fc); sizes.push((n.sizes[i] ?? 1) * (f.sizes[j] ?? 1)) }) }
    else { kids.push(f); sizes.push(n.sizes[i] ?? 1) }
  })
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...n, children: kids, sizes: sizes.map(s => s / total) }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const root = useWorkspace.getState().root
    if (!root) return
    const s = useEditor.getState()
    const paths = Object.values(s.groups).flatMap(g => g.tabs.filter(t => t.kind === 'file' && t.path).map(t => t.path!))
    const act = s.groups[s.activeGroup]?.activeId
    try { localStorage.setItem('tabs:' + root, JSON.stringify({ paths: [...new Set(paths)], active: act })) } catch { /* ignore */ }
  }, 400)
}

export const useDirtyCount = () => useDocs(s => Object.values(s.dirty).filter(Boolean).length)
export { dirtyPaths }
