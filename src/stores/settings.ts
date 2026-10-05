import { create } from 'zustand'
import { defaultSettings, type Settings } from '@shared/settings'
import { api, onEvent } from '../lib/api'
import { deepMerge } from '../lib/util'

type Patch = { [K in keyof Settings]?: Settings[K] extends (infer U)[] ? U[] : Settings[K] extends Record<string, unknown> ? Partial<Settings[K]> : Settings[K] } & Record<string, unknown>

interface SettingsState {
  settings: Settings
  loaded: boolean
  load(): Promise<void>
  update(patch: Patch): Promise<void>
  /** replace a whole top-level section */
  setSection<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaultSettings(),
  loaded: false,
  async load() {
    const s = await api.settings.get()
    set({ settings: s, loaded: true })
    onEvent('settings:changed', next => set({ settings: next }))
  },
  async update(patch) {
    set({ settings: deepMerge(get().settings, patch) })
    await api.settings.update(patch as Record<string, unknown>)
  },
  async setSection(key, value) {
    set({ settings: { ...get().settings, [key]: value } })
    await api.settings.setSection(key as string, value)
  }
}))

export const getSettings = () => useSettings.getState().settings
