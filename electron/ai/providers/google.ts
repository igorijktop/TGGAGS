import type { ModelInfo, ProviderConfig } from '../../../shared/settings'
import { errorFromResponse, httpFetch, joinUrl, makeAbort, networkError, sseEvents } from './http'
import { ProviderError, type ChatMessage, type ChatProvider, type ChatRequest, type FinishReason, type StreamEvent } from './types'
import { guessModelInfo } from './discovery'

/** Reduces a JSON Schema to the OpenAPI subset accepted by Gemini function declarations. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const s = { ...(schema as Record<string, unknown>) }
  for (const k of ['$schema', 'additionalProperties', 'default', 'examples', '$id', 'title', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'patternProperties', 'const']) delete s[k]
  if (Array.isArray(s.type)) {
    const types = (s.type as string[]).filter(t => t !== 'null')
    if ((s.type as string[]).includes('null')) s.nullable = true
    s.type = types[0] ?? 'string'
  }
  if (s.anyOf && Array.isArray(s.anyOf)) {
    const options = (s.anyOf as Record<string, unknown>[]).filter(o => o.type !== 'null')
    if (options.length === 1) { Object.assign(s, options[0]); delete s.anyOf; if ((s.anyOf as unknown) === undefined && (schema as { anyOf: Record<string, unknown>[] }).anyOf.length > options.length) s.nullable = true }
  }
  if (s.properties && typeof s.properties === 'object') {
    s.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, geminiSchema(v)]))
  }
  if (s.items) s.items = geminiSchema(s.items)
  if (typeof s.type === 'string') s.type = s.type.toLowerCase()
  return s
}

function toContents(msgs: ChatMessage[], vision: boolean): unknown[] {
  const out: { role: 'user' | 'model'; parts: unknown[] }[] = []
  const push = (role: 'user' | 'model', parts: unknown[]) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts })
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      push('user', m.content.map(c => c.type === 'text' ? { text: c.text } : vision ? { inlineData: { mimeType: c.mime, data: c.data } } : { text: '[image omitted: model has no vision]' }))
    } else if (m.role === 'assistant') {
      const parts: unknown[] = []
      if (m.text) parts.push({ text: m.text })
      for (const t of m.toolCalls ?? []) {
        const part: Record<string, unknown> = { functionCall: { name: t.name, args: (t.input ?? {}) as object } }
        if (t.providerMeta?.thoughtSignature) part.thoughtSignature = t.providerMeta.thoughtSignature
        parts.push(part)
      }
      if (!parts.length) parts.push({ text: '(no content)' })
      push('model', parts)
    } else {
      const parts: unknown[] = [{ functionResponse: { name: m.name, response: m.isError ? { error: m.content } : { output: m.content } } }]
      if (m.images?.length && vision) for (const i of m.images) parts.push({ inlineData: { mimeType: i.mime, data: i.data } })
      push('user', parts)
    }
  }
  return out
}

export class GoogleProvider implements ChatProvider {
  constructor(readonly config: ProviderConfig, private apiKey: string | undefined) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.config.headers ?? {}) }
    if (this.apiKey) h['x-goog-api-key'] = this.apiKey
    return h
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const model = req.model.replace(/^models\//, '')
    const url = joinUrl(this.config.baseUrl, `models/${model}:streamGenerateContent`) + '?alt=sse'
    const body: Record<string, unknown> = { contents: toContents(req.messages, req.modelInfo?.vision !== false) }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    if (req.tools?.length && req.modelInfo?.tools !== false) {
      body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }]
    }
    const gen: Record<string, unknown> = {}
    if (req.temperature !== undefined) gen.temperature = req.temperature
    if (req.maxTokens) gen.maxOutputTokens = req.maxTokens
    if (req.modelInfo?.reasoning !== false && /gemini-(2\.5|3)/.test(model)) {
      const budget = { off: 0, low: 1024, medium: 4096, high: 12000, xhigh: 20000, max: 24576 }[req.reasoning ?? 'medium']
      gen.thinkingConfig = { includeThoughts: req.showReasoning !== false && budget > 0, ...(/gemini-2\.5-pro/.test(model) && budget === 0 ? {} : { thinkingBudget: budget }) }
    }
    if (Object.keys(gen).length) body.generationConfig = gen

    const ab = makeAbort(req.signal, req.idleTimeoutMs ?? 120_000)
    try {
      let res: Response
      try { res = await httpFetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ab.signal }) }
      catch (e) {
        if (ab.timedOut) throw new ProviderError(`${this.config.name}: no response`, 'timeout')
        throw networkError(e, this.config.name, url)
      }
      if (!res.ok) throw await errorFromResponse(res, this.config.name)

      let n = 0
      let finish: FinishReason = 'stop'
      let sawCall = false
      let usage: { input: number; output: number; cacheRead?: number } | null = null
      try {
        for await (const ev of sseEvents(res, ab)) {
          let j: any
          try { j = JSON.parse(ev.data) } catch { continue }
          if (j.error) throw new ProviderError(`${this.config.name}: ${j.error.message ?? JSON.stringify(j.error)}`, 'other')
          if (j.usageMetadata) {
            const u = j.usageMetadata
            usage = { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: u.cachedContentTokenCount }
          }
          if (j.promptFeedback?.blockReason) { yield { type: 'finish', reason: 'refusal', detail: `Blocked: ${j.promptFeedback.blockReason}` }; return }
          const cand = j.candidates?.[0]
          if (!cand) continue
          for (const part of cand.content?.parts ?? []) {
            if (part.functionCall) {
              sawCall = true
              const id = part.functionCall.id ?? `call_${n++}_${Date.now().toString(36)}`
              const providerMeta = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined
              yield { type: 'tool_start', id, name: part.functionCall.name }
              yield { type: 'tool_call', id, name: part.functionCall.name, input: part.functionCall.args ?? {}, providerMeta }
            } else if (typeof part.text === 'string' && part.text) {
              yield part.thought ? { type: 'reasoning', delta: part.text } : { type: 'text', delta: part.text }
            }
          }
          if (cand.finishReason) {
            finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(cand.finishReason) ? 'refusal' : 'stop'
          }
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (ab.timedOut) throw new ProviderError(`${this.config.name}: stream stalled`, 'timeout')
        if ((e as Error).name === 'AbortError') throw new ProviderError('Request aborted', 'aborted', { retryable: false })
        throw networkError(e, this.config.name, url)
      }
      if (usage) yield { type: 'usage', ...usage }
      yield { type: 'finish', reason: sawCall && finish !== 'length' ? 'tool_calls' : finish }
    } finally { ab.done() }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = joinUrl(this.config.baseUrl, 'models') + '?pageSize=200'
    const ab = makeAbort(signal, 20_000)
    try {
      let res: Response
      try { res = await httpFetch(url, { headers: this.headers(), signal: ab.signal }) } catch (e) { throw networkError(e, this.config.name, url) }
      if (!res.ok) throw await errorFromResponse(res, this.config.name)
      const j = await res.json() as { models?: { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[] }
      return (j.models ?? [])
        .filter(m => m.supportedGenerationMethods?.some(x => /generateContent|predict/.test(x)))
        .map(m => {
          const id = m.name.replace(/^models\//, '')
          const g = guessModelInfo(id)
          return { ...g, name: m.displayName ?? id, contextWindow: m.inputTokenLimit ?? g.contextWindow, maxOutput: m.outputTokenLimit, vision: true, tools: !/image|imagen|embed/.test(id) }
        })
    } finally { ab.done() }
  }
}
