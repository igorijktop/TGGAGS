import type { ModelInfo, ModelRef, ProviderConfig } from '@shared/settings'
import { presetToProvider, type ProviderPreset } from '@shared/presets'
import { api } from './api'
import { useSettings } from '../stores/settings'

export const keysChanged = () => window.dispatchEvent(new Event('tgg:keys-changed'))

export function uniqueProviderId(base: string, existing: ProviderConfig[]): string {
  let id = base, n = 2
  while (existing.some(p => p.id === id)) id = `${base}-${n++}`
  return id
}

/** Picks the model new chats should start with: the first chat model that can use tools. */
export function pickDefaultModel(p: ProviderConfig): ModelRef | null {
  const m = p.models.find(x => x.modality === 'chat' && x.tools !== false) ?? p.models.find(x => x.modality === 'chat')
  return m ? { provider: p.id, model: m.id } : null
}

export async function addProvider(cfg: ProviderConfig, key?: string): Promise<void> {
  const st = useSettings.getState()
  if (key) await api.providers.setKey(cfg.id, key)
  await st.setSection('providers', [...st.settings.providers, cfg])
  const s = useSettings.getState().settings
  if (!s.ai.defaultModel) { const d = pickDefaultModel(cfg); if (d) await useSettings.getState().update({ ai: { defaultModel: d } } as never) }
  const img = cfg.models.find(m => m.modality === 'image')
  if (img && !s.images.defaultModel) await useSettings.getState().update({ images: { defaultModel: { provider: cfg.id, model: img.id } } } as never)
  keysChanged()
}

export async function connectPreset(preset: ProviderPreset, o: { key?: string; baseUrl?: string; name?: string }): Promise<ProviderConfig> {
  const existing = useSettings.getState().settings.providers
  const cfg = presetToProvider(preset, uniqueProviderId(preset.presetId, existing))
  if (o.baseUrl) cfg.baseUrl = o.baseUrl.trim().replace(/\/+$/, '')
  if (o.name) cfg.name = o.name
  if (!cfg.models.length || cfg.local) {
    try { const found = await api.providers.discover(cfg, o.key); if (found.length) cfg.models = found } catch { /* keep presets */ }
  }
  await addProvider(cfg, o.key)
  return cfg
}

export async function updateProvider(cfg: ProviderConfig): Promise<void> {
  const st = useSettings.getState()
  await st.setSection('providers', st.settings.providers.map(p => (p.id === cfg.id ? cfg : p)))
  keysChanged()
}

export async function removeProvider(id: string): Promise<void> {
  const st = useSettings.getState()
  await api.providers.setKey(id, '').catch(() => undefined)
  await st.setSection('providers', st.settings.providers.filter(p => p.id !== id))
  const s = useSettings.getState().settings
  if (s.ai.defaultModel?.provider === id) await useSettings.getState().update({ ai: { defaultModel: null } } as never)
  keysChanged()
}

export const chatModels = (p: ProviderConfig): ModelInfo[] => p.models.filter(m => m.modality === 'chat')
export const imageModels = (p: ProviderConfig): ModelInfo[] => p.models.filter(m => m.modality === 'image')
