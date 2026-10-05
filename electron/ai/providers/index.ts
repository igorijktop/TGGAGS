import type { ModelInfo, ModelRef, ProviderConfig, Settings } from '../../../shared/settings'
import { credentials } from '../../services/credentials'
import { settings } from '../../services/settings'
import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { OpenAIProvider } from './openai'
import { ProviderError, type ChatProvider } from './types'

export * from './types'

export function providerKeyName(id: string): string { return `provider:${id}` }

export function resolveApiKey(cfg: ProviderConfig): string | undefined {
  const stored = credentials.get(providerKeyName(cfg.id))
  if (stored) return stored
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv]
  return undefined
}

export function getProviderConfig(id: string, s: Settings = settings.get()): ProviderConfig {
  const cfg = s.providers.find(p => p.id === id)
  if (!cfg) throw new ProviderError(`Unknown provider "${id}". Add it in Settings → Models.`, 'not_found', { retryable: false })
  return cfg
}

export function createProvider(cfg: ProviderConfig, keyOverride?: string): ChatProvider {
  const key = keyOverride || resolveApiKey(cfg)
  if (cfg.requiresKey && !key) {
    throw new ProviderError(`${cfg.name} needs an API key. Open Settings → Models and add one.`, 'auth', { retryable: false })
  }
  switch (cfg.protocol) {
    case 'anthropic': return new AnthropicProvider(cfg, key)
    case 'google': return new GoogleProvider(cfg, key)
    case 'openai': return new OpenAIProvider(cfg, key)
    default: throw new ProviderError(`${cfg.name} is an image provider and cannot be used for chat.`, 'bad_request', { retryable: false })
  }
}

export function findModel(ref: ModelRef, s: Settings = settings.get()): { provider: ProviderConfig; info: ModelInfo | undefined } {
  const provider = getProviderConfig(ref.provider, s)
  return { provider, info: provider.models.find(m => m.id === ref.model) }
}

export function allChatModels(s: Settings = settings.get()): { ref: ModelRef; info: ModelInfo; provider: ProviderConfig }[] {
  const out: { ref: ModelRef; info: ModelInfo; provider: ProviderConfig }[] = []
  for (const p of s.providers) {
    if (!p.enabled || (p.protocol !== 'openai' && p.protocol !== 'anthropic' && p.protocol !== 'google')) continue
    for (const m of p.models) if (m.modality === 'chat') out.push({ ref: { provider: p.id, model: m.id }, info: m, provider: p })
  }
  return out
}

export async function testProvider(cfg: ProviderConfig, keyOverride?: string): Promise<{ ok: boolean; ms: number; message: string; models?: number }> {
  const t0 = Date.now()
  try {
    const p = createProvider(cfg, keyOverride)
    const models = await p.listModels()
    return { ok: true, ms: Date.now() - t0, message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`, models: models.length }
  } catch (e) {
    const err = e as ProviderError
    // Some providers do not support listing; a 404/405 there is not a connection failure.
    if (err.kind === 'not_found' && cfg.protocol === 'openai') return { ok: true, ms: Date.now() - t0, message: 'Server reachable (it does not list models; add model ids manually).' }
    return { ok: false, ms: Date.now() - t0, message: err.message }
  }
}

export async function discoverModels(cfg: ProviderConfig, keyOverride?: string): Promise<ModelInfo[]> {
  return createProvider(cfg, keyOverride).listModels()
}
