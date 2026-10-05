import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo, ProviderConfig } from '../../../shared/settings'
import { httpFetch, makeAbort, networkError, safeParseJson } from './http'
import { classifyStatus, ProviderError, type ChatMessage, type ChatProvider, type ChatRequest, type FinishReason, type StreamEvent } from './types'
import { guessModelInfo } from './discovery'

/** Claude 4.6+ models use adaptive thinking + `output_config.effort`; `budget_tokens` is rejected there. */
export const isAdaptiveClaude = (model: string) => /^claude-(fable|mythos|opus-(4-[6-9]|[5-9])|sonnet-(4-6|[5-9]))/.test(model)
/** Models eligible for server-side refusal fallbacks on the first-party API. */
const supportsFallbacks = (model: string) => /^claude-(fable-5-1|opus-5-5|sonnet-5-5)/.test(model)

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')

function toAnthropicMessages(msgs: ChatMessage[], vision: boolean, echoThinkingFrom: number): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  const push = (role: 'user' | 'assistant', content: Anthropic.ContentBlockParam[]) => {
    const last = out[out.length - 1]
    if (last && last.role === role && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push(...content)
    else out.push({ role, content })
  }
  msgs.forEach((m, i) => {
    if (m.role === 'user') {
      const blocks: Anthropic.ContentBlockParam[] = []
      for (const c of m.content) {
        if (c.type === 'text') { if (c.text.trim()) blocks.push({ type: 'text', text: c.text }) }
        else if (vision) blocks.push({ type: 'image', source: { type: 'base64', media_type: c.mime as 'image/png', data: c.data } })
        else blocks.push({ type: 'text', text: '[image omitted: model has no vision]' })
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '(empty message)' })
      push('user', blocks)
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = []
      // Thinking blocks must be echoed unchanged within the current tool-use loop only.
      if (i >= echoThinkingFrom) {
        for (const r of m.reasoning ?? []) {
          if (r.redacted) blocks.push({ type: 'redacted_thinking', data: r.redacted })
          else if (r.signature) blocks.push({ type: 'thinking', thinking: r.text, signature: r.signature })
        }
      }
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text })
      for (const t of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: sanitizeId(t.id), name: t.name, input: (t.input ?? {}) as Record<string, unknown> })
      if (!blocks.length) blocks.push({ type: 'text', text: '(no content)' })
      push('assistant', blocks)
    } else {
      const content: Anthropic.ToolResultBlockParam['content'] = m.images?.length && vision
        ? [{ type: 'text', text: m.content || '(no output)' }, ...m.images.map(img => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.data } }))]
        : (m.content || (m.isError ? 'Error' : '(no output)'))
      push('user', [{ type: 'tool_result', tool_use_id: sanitizeId(m.toolCallId), content, is_error: m.isError || undefined }])
    }
  })
  return out
}

interface BlockAcc { type: string; id?: string; name?: string; json: string; signature?: string; redacted?: string }

export class AnthropicProvider implements ChatProvider {
  constructor(readonly config: ProviderConfig, private apiKey: string | undefined) {}

  private firstParty(): boolean { return /(^|\/\/)api\.anthropic\.com/.test(this.config.baseUrl) }

  private client(timeoutMs = 600_000): Anthropic {
    const headers: Record<string, string> = { ...(this.config.headers ?? {}) }
    // Gateways that front the Anthropic API frequently authenticate with a bearer token.
    if (!this.firstParty() && this.apiKey) headers.authorization ??= `Bearer ${this.apiKey}`
    return new Anthropic({
      apiKey: this.apiKey ?? 'not-needed',
      baseURL: this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, ''),
      fetch: httpFetch as unknown as typeof fetch,
      maxRetries: 0,
      timeout: timeoutMs,
      defaultHeaders: headers
    })
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const info = req.modelInfo
    const adaptive = isAdaptiveClaude(req.model)
    const wantsThinking = req.reasoning !== undefined && req.reasoning !== 'off'
    const maxTokens = Math.max(1024, Math.min(req.maxTokens ?? info?.maxOutput ?? 32000, info?.maxOutput ?? 128000))
    const firstParty = this.firstParty()
    // Index of the first assistant message that belongs to the current tool-use loop (after the last real user turn).
    let lastUser = -1
    req.messages.forEach((m, i) => { if (m.role === 'user') lastUser = i })

    let echoThinking = true
    let useThinkingParam = true
    let useFallbacks = firstParty && supportsFallbacks(req.model)
    const ab = makeAbort(req.signal, req.idleTimeoutMs ?? 120_000)

    try {
      for (let attempt = 0; ; attempt++) {
        const params: Record<string, unknown> = {
          model: req.model,
          max_tokens: maxTokens,
          messages: toAnthropicMessages(req.messages, info?.vision !== false, echoThinking ? lastUser + 1 : Number.MAX_SAFE_INTEGER),
          stream: true
        }
        if (req.system) params.system = [{ type: 'text', text: req.system }]
        if (firstParty) params.cache_control = { type: 'ephemeral' }
        if (req.tools?.length) {
          params.tools = req.tools.map(t => ({
            name: t.name, description: t.description, input_schema: t.parameters,
            ...(firstParty ? { eager_input_streaming: true } : {})
          }))
        }
        if (adaptive) {
          if (useThinkingParam && wantsThinking) params.thinking = { type: 'adaptive', ...(req.showReasoning ? { display: 'summarized' } : {}) }
          params.output_config = { effort: wantsThinking ? req.reasoning : 'low' }
          // sampling parameters are not accepted on these models
        } else if (info?.reasoning && wantsThinking && useThinkingParam) {
          const budget = ({ low: 2048, medium: 6000, high: 16000, xhigh: 24000, max: 32000 } as Record<string, number>)[req.reasoning!] ?? 6000
          params.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 512) }
        } else if (req.temperature !== undefined) params.temperature = req.temperature
        if (useFallbacks) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default' }

        let stream: AsyncIterable<any>
        try {
          const c = this.client()
          const api: any = useFallbacks ? c.beta.messages : c.messages
          stream = await api.create(params, { signal: ab.signal })
        } catch (e) {
          const pe = this.toProviderError(e, ab.timedOut, req.idleTimeoutMs)
          if (pe.status === 400 && attempt < 2) {
            if (useFallbacks && /fallback|beta/i.test(pe.message)) { useFallbacks = false; continue }
            if (/thinking|signature|effort|output_config|cache_control|eager_input/i.test(pe.message)) {
              if (echoThinking) { echoThinking = false; continue }
              if (useThinkingParam) { useThinkingParam = false; continue }
            }
          }
          throw pe
        }

        const blocks = new Map<number, BlockAcc>()
        let stopReason: string | null = null
        let stopDetail: string | undefined
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        try {
          for await (const ev of stream) {
            ab.touch()
            switch (ev.type) {
              case 'message_start': {
                const u = ev.message?.usage ?? {}
                usage.input = u.input_tokens ?? 0; usage.cacheRead = u.cache_read_input_tokens ?? 0; usage.cacheWrite = u.cache_creation_input_tokens ?? 0; usage.output = u.output_tokens ?? 0
                break
              }
              case 'content_block_start': {
                const b = ev.content_block ?? {}
                blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '', redacted: b.type === 'redacted_thinking' ? b.data : undefined })
                if (b.type === 'tool_use') yield { type: 'tool_start', id: b.id, name: b.name }
                if (b.type === 'fallback') yield { type: 'notice', text: `${b.from?.model ?? 'The model'} declined this request; ${b.to?.model ?? 'a fallback model'} continued.` }
                break
              }
              case 'content_block_delta': {
                const acc = blocks.get(ev.index)
                const d = ev.delta ?? {}
                if (d.type === 'text_delta') yield { type: 'text', delta: d.text }
                else if (d.type === 'thinking_delta') yield { type: 'reasoning', delta: d.thinking }
                else if (d.type === 'signature_delta' && acc) acc.signature = (acc.signature ?? '') + d.signature
                else if (d.type === 'input_json_delta' && acc) { acc.json += d.partial_json; if (acc.id) yield { type: 'tool_args', id: acc.id, delta: d.partial_json } }
                break
              }
              case 'content_block_stop': {
                const acc = blocks.get(ev.index)
                if (!acc) break
                if (acc.type === 'thinking') yield { type: 'reasoning_block', signature: acc.signature }
                else if (acc.type === 'redacted_thinking') yield { type: 'reasoning_block', redacted: acc.redacted }
                else if (acc.type === 'tool_use' && acc.id && acc.name) {
                  const parsed = safeParseJson(acc.json)
                  yield parsed.ok ? { type: 'tool_call', id: acc.id, name: acc.name, input: parsed.value } : { type: 'tool_call', id: acc.id, name: acc.name, input: {}, parseError: parsed.error }
                }
                break
              }
              case 'message_delta': {
                stopReason = ev.delta?.stop_reason ?? stopReason
                const sd = ev.delta?.stop_details
                if (sd) stopDetail = [sd.category, sd.explanation].filter(Boolean).join(': ') || undefined
                const u = ev.usage ?? {}
                if (u.output_tokens !== undefined) usage.output = u.output_tokens
                if (u.input_tokens) usage.input = u.input_tokens
                if (u.cache_read_input_tokens) usage.cacheRead = u.cache_read_input_tokens
                break
              }
              case 'error':
                throw new ProviderError(`${this.config.name}: ${ev.error?.message ?? 'stream error'}`, ev.error?.type === 'overloaded_error' ? 'overloaded' : ev.error?.type === 'rate_limit_error' ? 'rate_limit' : 'other')
              default: break
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e
          throw this.toProviderError(e, ab.timedOut, req.idleTimeoutMs)
        }
        yield { type: 'usage', input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }
        const reason: FinishReason = stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : stopReason === 'refusal' ? 'refusal' : 'stop'
        yield { type: 'finish', reason, detail: stopDetail }
        return
      }
    } finally { ab.done() }
  }

  private toProviderError(e: unknown, timedOut: boolean, idleMs = 120000): ProviderError {
    if (e instanceof ProviderError) return e
    if (timedOut) return new ProviderError(`${this.config.name}: no data for ${idleMs / 1000}s`, 'timeout')
    if (e instanceof Anthropic.APIUserAbortError || (e as Error)?.name === 'AbortError') return new ProviderError('Request aborted', 'aborted', { retryable: false })
    if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
      const kind = classifyStatus(e.status, e.message)
      const ra = Number((e.headers as Record<string, string> | undefined)?.['retry-after'])
      const hint = kind === 'auth' ? ' (check the API key in Settings → Models)' : kind === 'not_found' ? ' (check the base URL and model name)' : ''
      return new ProviderError(`${this.config.name}: ${e.status} ${e.message.replace(/^\d+\s+/, '')}${hint}`, kind, { status: e.status, retryAfterMs: ra > 0 ? ra * 1000 : undefined })
    }
    return networkError(e, this.config.name, this.config.baseUrl)
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    try {
      for await (const m of this.client(20_000).models.list({ limit: 100 }, { signal })) {
        const x = m as unknown as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number; capabilities?: { image_input?: { supported?: boolean }; thinking?: { supported?: boolean } } }
        const g = guessModelInfo(x.id)
        out.push({ ...g, name: x.display_name ?? x.id, contextWindow: x.max_input_tokens ?? g.contextWindow, maxOutput: x.max_tokens, vision: x.capabilities?.image_input?.supported ?? true, reasoning: x.capabilities?.thinking?.supported ?? g.reasoning, tools: true })
      }
    } catch (e) { throw this.toProviderError(e, false) }
    return out
  }
}
