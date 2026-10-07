import { create } from 'zustand'
import type { UpdateState } from '@shared/update'
import { api, onEvent } from '../lib/api'
import { dirtyPaths, saveAll } from '../lib/docs'
import { dialogs, toast } from './ui'
import { useAi } from './ai'

interface UpdateStore {
  state: UpdateState | null
  /** the details popover under the Update button */
  open: boolean
  init(): Promise<void>
  check(manual?: boolean): Promise<UpdateState>
  /** one click: download, then install */
  start(): Promise<void>
  cancel(): Promise<void>
  install(): Promise<void>
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  state: null,
  open: false,

  async init() {
    onEvent('update:state', s => set({ state: s }))
    set({ state: await api.updates.state().catch(() => null) })
  },

  async check(manual = false) {
    const s = await api.updates.check(manual)
    set({ state: s })
    return s
  },

  async start() {
    const s = await api.updates.download()
    set({ state: s })
    if (s.status === 'ready') await get().install()
    else if (s.status === 'error') toast.error(s.message)
  },

  async cancel() { await api.updates.cancel() },

  async install() {
    const dirty = dirtyPaths()
    if (dirty.length) {
      const ok = await dialogs.confirm({ title: 'Save your changes and update?', message: `${dirty.length === 1 ? 'One file has' : `${dirty.length} files have`} unsaved changes. They are saved first, then the app restarts to finish the update.`, confirmLabel: 'Save and update' })
      if (!ok) return
      await saveAll()
    }
    const busy = Object.entries(useAi.getState().running).filter(([, r]) => r).map(([id]) => id)
    if (busy.length) {
      const ok = await dialogs.confirm({ title: 'The agent is still working', message: 'Updating restarts the app and stops the running task. File changes it already made stay on disk.', confirmLabel: 'Stop and update', danger: true })
      if (!ok) return
      await Promise.all(busy.map(id => api.ai.abort(id).catch(() => undefined)))
    }
    set({ open: false })
    try {
      const r = await api.updates.install()
      if (r === 'revealed') toast.info('The new installer is downloaded — run it to finish the update.')
      else toast.info('Updating… the app restarts in a moment.')
    } catch (e) { toast.error((e as Error).message) }
  }
}))
