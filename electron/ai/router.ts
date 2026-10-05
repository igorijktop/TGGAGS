import type { Session } from '../../shared/ai'
import type { AgentConfig, ModelInfo, ModelRef, ProviderConfig, Settings } from '../../shared/settings'
import { refKey, sameRef } from '../../shared/settings'
import { allChatModels } from './providers'

export interface ResolveInput {
  settings: Settings
  agent: AgentConfig
  session: Session
  explicit?: ModelRef | null
  hasImages: boolean
  promptTokens: number
  userText: string
}

export interface Candidate { ref: ModelRef; info: ModelInfo | undefined; provider: ProviderConfig }

function lookup(s: Settings, ref: ModelRef | null | undefined): Candidate | null {
  if (!ref) return null
  const p = s.providers.find(x => x.id === ref.provider && x.enabled)
  if (!p) return null
  return { ref, info: p.models.find(m => m.id === ref.model), provider: p }
}

/** Ordered list of models to try for a request (first = preferred, rest = fallbacks). */
export function resolveModels(i: ResolveInput): Candidate[] {
  const s = i.settings
  const out: Candidate[] = []
  const push = (c: Candidate | null) => { if (c && !out.some(o => sameRef(o.ref, c.ref))) out.push(c) }
  const r = s.router

  let primary: ModelRef | null | undefined = i.explicit
  if (!primary && r.enabled) {
    const text = i.userText.toLowerCase()
    for (const rule of r.rules) {
      const w = rule.when
      if (w.agent && w.agent !== i.agent.id) continue
      if (w.hasImages !== undefined && w.hasImages !== i.hasImages) continue
      if (w.minTokens !== undefined && i.promptTokens < w.minTokens) continue
      if (w.keywords?.length && !w.keywords.some(k => text.includes(k.toLowerCase()))) continue
      if (lookup(s, rule.use)) { primary = rule.use; break }
    }
    if (!primary && i.agent.id === 'plan' && r.roles.plan) primary = r.roles.plan
    if (!primary) primary = r.roles.default
  }
  primary ??= i.session.model ?? i.agent.model ?? s.ai.defaultModel
  push(lookup(s, primary))

  // capability corrections
  const first = out[0]
  if (first && i.hasImages && first.info?.vision === false) {
    const alt = lookup(s, r.roles.vision) ?? allChatModels(s).find(m => m.info.vision)
    if (alt) out.unshift({ ref: alt.ref, info: alt.info, provider: alt.provider })
  }
  const win = out[0]?.info?.contextWindow
  if (out[0] && win && i.promptTokens > win * 0.95 && r.roles.long) { const alt = lookup(s, r.roles.long); if (alt) out.unshift(alt) }

  if (r.enabled) for (const f of r.fallbacks) push(lookup(s, f))
  if (!out.length) { const any = allChatModels(s)[0]; if (any) push({ ref: any.ref, info: any.info, provider: any.provider }) }
  return out
}

export function smallModel(s: Settings, current: Candidate): Candidate {
  return lookup(s, s.router.roles.small) ?? current
}

export function describeRoute(c: Candidate[]): string { return c.map(x => refKey(x.ref)).join(' → ') }
