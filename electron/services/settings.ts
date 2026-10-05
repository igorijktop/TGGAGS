import { defaultSettings, type Settings } from '../../shared/settings'
import { dataPath } from './paths'
import { JsonStore, deepMerge, readJsonSync } from './storage'
import { emit } from './events'
import { join } from 'node:path'
import { PROJECT_DIR } from './paths'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

class SettingsService {
  private store!: JsonStore<Settings>

  init(): void {
    this.store = new JsonStore<Settings>(dataPath('settings.json'), defaultSettings(), 400)
    // Fill in keys that did not exist in older settings files.
    this.store.value = deepMerge(defaultSettings(), this.store.value)
  }

  get(): Settings { return this.store.value }

  update(patch: DeepPartial<Settings>): Settings {
    this.store.value = deepMerge(this.store.value, patch)
    this.store.save()
    emit('settings:changed', this.store.value)
    return this.store.value
  }

  reset(section?: keyof Settings): Settings {
    const d = defaultSettings()
    this.store.value = section ? { ...this.store.value, [section]: d[section] } : { ...d, providers: this.store.value.providers, ui: this.store.value.ui }
    this.store.save()
    emit('settings:changed', this.store.value)
    return this.store.value
  }

  /** Global settings combined with the project overlay in `<root>/.tgg/settings.json`. */
  effective(root?: string | null): Settings {
    const g = this.store.value
    if (!root) return g
    const overlay = readJsonSync<Partial<Settings>>(join(root, PROJECT_DIR, 'settings.json'), {})
    if (!Object.keys(overlay).length) return g
    const merged = deepMerge(g, { ...overlay, permissions: undefined, hooks: undefined, agents: undefined, context: undefined })
    merged.permissions = { rules: [...g.permissions.rules, ...(overlay.permissions?.rules ?? [])] }
    merged.hooks = [...g.hooks, ...(overlay.hooks ?? [])]
    const byId = new Map(g.agents.map(a => [a.id, a]))
    for (const a of overlay.agents ?? []) byId.set(a.id, a)
    merged.agents = [...byId.values()]
    merged.context = {
      ...g.context, ...(overlay.context ?? {}),
      excludePatterns: [...g.context.excludePatterns, ...(overlay.context?.excludePatterns ?? [])]
    }
    return merged
  }

  flush(): void { this.store?.flush() }
}

export const settings = new SettingsService()
