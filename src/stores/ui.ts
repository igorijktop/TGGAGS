import { create } from 'zustand'
import type { ReactNode } from 'react'
import { uid } from '../lib/util'
import type { LucideIcon } from 'lucide-react'

export type SidebarView = 'explorer' | 'search' | 'scm' | 'run' | 'extensions' | 'ai' | 'agents' | 'models' | 'images' | 'github'
export type PanelTab = 'terminal' | 'problems' | 'output' | 'debug'

export interface Toast { id: string; kind: 'success' | 'error' | 'warn' | 'info'; message: string; action?: { label: string; run(): void }; sticky?: boolean }
export interface MenuEntry { label?: string; icon?: LucideIcon; hint?: string; danger?: boolean; disabled?: boolean; separator?: boolean; checked?: boolean; title?: string; onClick?(): void; children?: MenuEntry[] }
export interface ContextMenuState { x: number; y: number; items: MenuEntry[] }
export interface DialogReq {
  id: string
  kind: 'confirm' | 'prompt' | 'alert' | 'custom'
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  placeholder?: string
  initial?: string
  validate?(v: string): string | null
  render?(close: (v?: unknown) => void): ReactNode
  wide?: boolean
  resolve(v: unknown): void
}

interface UiState {
  sidebarView: SidebarView
  sidebarVisible: boolean
  sidebarWidth: number
  aiVisible: boolean
  aiWidth: number
  panelVisible: boolean
  panelHeight: number
  panelTab: PanelTab
  panelMaximized: boolean
  chatFocus: boolean
  zen: boolean
  maximized: boolean
  toasts: Toast[]
  dialogs: DialogReq[]
  contextMenu: ContextMenuState | null
  palette: { open: boolean; value: string }
  notifications: { id: string; message: string; kind: Toast['kind']; ts: number }[]
  set(p: Partial<UiState>): void
  showView(v: SidebarView): void
  toggleSidebar(): void
  toggleAi(): void
  togglePanel(tab?: PanelTab): void
  toast(t: Omit<Toast, 'id'>): string
  dismissToast(id: string): void
  openContextMenu(x: number, y: number, items: MenuEntry[]): void
  closeContextMenu(): void
  openPalette(value?: string): void
  closePalette(): void
}

export const useUi = create<UiState>((set, get) => ({
  sidebarView: 'explorer', sidebarVisible: true, sidebarWidth: 290, aiVisible: false, aiWidth: 440, panelVisible: false, panelHeight: 280, panelTab: 'terminal', panelMaximized: false,
  chatFocus: false, zen: false, maximized: false, toasts: [], dialogs: [], contextMenu: null, palette: { open: false, value: '' }, notifications: [],
  set: p => set(p),
  showView(v) { const s = get(); set({ sidebarView: v, sidebarVisible: s.sidebarView === v && s.sidebarVisible && !s.chatFocus ? false : true, chatFocus: false }) },
  toggleSidebar() { set({ sidebarVisible: !get().sidebarVisible, chatFocus: false }) },
  toggleAi() { set({ aiVisible: !get().aiVisible, chatFocus: false }) },
  togglePanel(tab) { const s = get(); if (tab && (s.panelTab !== tab || !s.panelVisible)) set({ panelTab: tab, panelVisible: true }); else set({ panelVisible: !s.panelVisible }) },
  toast(t) {
    const id = uid('t-')
    set(s => ({ toasts: [...s.toasts, { ...t, id }].slice(-5), notifications: [{ id, message: t.message, kind: t.kind, ts: Date.now() }, ...s.notifications].slice(0, 50) }))
    if (!t.sticky) setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 4500)
    return id
  },
  dismissToast(id) { set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })) },
  openContextMenu(x, y, items) { set({ contextMenu: { x, y, items } }) },
  closeContextMenu() { if (get().contextMenu) set({ contextMenu: null }) },
  openPalette(value = '') { set({ palette: { open: true, value } }) },
  closePalette() { set({ palette: { open: false, value: '' } }) }
}))

export const toast = {
  success: (message: string, action?: Toast['action']) => useUi.getState().toast({ kind: 'success', message, action }),
  error: (message: string) => useUi.getState().toast({ kind: 'error', message }),
  warn: (message: string) => useUi.getState().toast({ kind: 'warn', message }),
  info: (message: string, action?: Toast['action']) => useUi.getState().toast({ kind: 'info', message, action })
}

function push<T>(d: Omit<DialogReq, 'id' | 'resolve'>): Promise<T> {
  return new Promise<T>(resolve => { useUi.setState(s => ({ dialogs: [...s.dialogs, { ...d, id: uid('d-'), resolve: resolve as (v: unknown) => void }] })) })
}

export const dialogs = {
  confirm: (o: { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => push<boolean>({ kind: 'confirm', ...o }),
  prompt: (o: { title: string; message?: ReactNode; initial?: string; placeholder?: string; confirmLabel?: string; validate?(v: string): string | null }) => push<string | null>({ kind: 'prompt', ...o }),
  alert: (o: { title: string; message?: ReactNode }) => push<void>({ kind: 'alert', ...o }),
  custom: <T,>(o: { title: string; render(close: (v?: unknown) => void): ReactNode; wide?: boolean }) => push<T | undefined>({ kind: 'custom', ...o })
}

export function closeDialog(id: string, value: unknown) {
  const d = useUi.getState().dialogs.find(x => x.id === id)
  useUi.setState(s => ({ dialogs: s.dialogs.filter(x => x.id !== id) }))
  d?.resolve(value)
}
