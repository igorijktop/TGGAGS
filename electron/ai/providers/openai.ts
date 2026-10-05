import type { ModelInfo, ProviderConfig } from '../../../shared/settings'
import { errorFromResponse, httpFetch, joinUrl, makeAbort, networkError, safeParseJson, sseEvents, ThinkSplitter } from './http'
import { ProviderError, type ChatMessage, type ChatProvider, type ChatRequest, type FinishReason, type StreamEvent } from './types'
import { guessModelInfo } from './discovery'

interface OAIToolCallAcc { id: string; name: string; args: string; started: boolean }

const isReasoningFamily = (m: string) => /^(o\d|gpt-5)/i.test(m.replace(/^.*\//, ''))

function toOpenAIMessages(system: string | undefined, msgs: ChatMessage[], vision: boolean): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of msgs) {
    if (m.role === 'user') {
      const hasImage = m.content.some(c => c.type === 'image')
      if (!hasImage || !vision) out.push({ role: 'user', content: m.content.map(c => c.type === 'text' ? c.text : '[image omitted: model has no vision]').join('\n\n') })
      else out.push({
        role: 'user',
        content: m.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image_url', image_url: { url: `data:${c.mime};base64,${c.data}` } })
      })
    } else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.text || (m.toolCalls?.length ? null : '') }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }))
      }
      out.push(msg)
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || (m.isError ? 'Error' : '(no output)') })
      if (m.images?.length && vision) {
        out.push({ role: 'user', content: [{ type: 'text', text: `Image output from tool ${m.name}:` }, ...m.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] })
      }
    }
  }
  return out
}

export class OpenAIProvider implements ChatProvider {
  constructor(readonly config: ProviderConfig, private apiKey: string | undefined) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.config.headers ?? {}) }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    if (this.config.baseUrl.includes('openrouter.ai')) { h['HTTP-Referer'] ??= 'https://github.com/igorijktop/TGGAGS'; h['X-Title'] ??= 'TGGAGS IDE' }
    return h
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const url = joinUrl(this.config.baseUrl, 'chat/completions')
    const info = req.modelInfo
    const reasoningModel = isReasoningFamily(req.model)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages, info?.vision !== false),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (req.tools?.length && info?.tools !== false) {
      body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      body.tool_choice = 'auto'
    }
    if (req.maxTokens) body[reasoningModel ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
    if (req.temperature !== undefined && !reasoningModel) body.temperature = req.temperature
    if (reasoningModel && req.reasoning) body.reasoning_effort = req.reasoning === 'off' ? (/^gpt-5/i.test(req.model) ? 'minimal' : undefined) : (req.reasoning === 'xhigh' || req.reasoning === 'max' ? 'high' : req.reasoning)
    if (this.config.baseUrl.includes('openrouter.ai') && req.reasoning && req.reasoning !== 'off') body.reasoning = { effort: req.reasoning === 'xhigh' || req.reasoning === 'max' ? 'high' : req.reasoning }

    const ab = makeAbort(req.signal, req.idleTimeoutMs ?? 120_000)
    try {
      let res: Response
      for (let attempt = 0; ; attempt++) {
        try {
          res = await httpFetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ab.signal })
        } catch (e) {
          if (ab.timedOut) throw new ProviderError(`${this.config.name}: no response within ${(req.idleTimeoutMs ?? 120000) / 1000}s`, 'timeout')
          throw networkError(e, this.config.name, url)
        }
        if (res.ok) break
        const err = await errorFromResponse(res, this.config.name)
        // Some OpenAI-compatible servers reject optional parameters; drop them and retry once.
        if (err.status === 400 && attempt === 0 && /stream_options|tool_choice|reasoning_effort|max_completion_tokens|unknown (field|parameter)|unrecognized/i.test(err.message)) {
          delete body.stream_options; delete body.tool_choice; delete body.reasoning_effort
          if (/max_completion_tokens/.test(err.message) && body.max_completion_tokens) { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens }
          continue
        }
        throw err
      }

      const calls = new Map<number, OAIToolCallAcc>()
      const splitter = new ThinkSplitter()
      let finish: FinishReason = 'other'
      let usage: { input: number; output: number; cacheRead?: number } | null = null
      try {
        for await (const ev of sseEvents(res, ab)) {
          if (ev.data === '[DONE]') break
          let j: any
          try { j = JSON.parse(ev.data) } catch { continue }
          if (j.error) throw new ProviderError(`${this.config.name}: ${j.error.message ?? JSON.stringify(j.error)}`, 'other')
          if (j.usage) {
            usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0, cacheRead: j.usage.prompt_tokens_details?.cached_tokens }
          }
          const choice = j.choices?.[0]
          if (!choice) continue
          const d = choice.delta ?? {}
          const reasoningDelta = d.reasoning_content ?? d.reasoning
          if (typeof reasoningDelta === 'string' && reasoningDelta) yield { type: 'reasoning', delta: reasoningDelta }
          if (typeof d.content === 'string' && d.content) {
            const { text, reasoning } = splitter.push(d.content)
            if (reasoning) yield { type: 'reasoning', delta: reasoning }
            if (text) yield { type: 'text', delta: text }
          }
          for (const tc of d.tool_calls ?? []) {
            const idx: number = tc.index ?? 0
            let acc = calls.get(idx)
            if (!acc) { acc = { id: tc.id ?? '', name: '', args: '', started: false }; calls.set(idx, acc) }
            if (tc.id && !acc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (!acc.started && acc.name) { acc.started = true; if (!acc.id) acc.id = `call_${idx}_${Date.now().toString(36)}`; yield { type: 'tool_start', id: acc.id, name: acc.name } }
            if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
              acc.args += tc.function.arguments
              if (acc.started) yield { type: 'tool_args', id: acc.id, delta: tc.function.arguments }
            }
          }
          if (choice.finish_reason) {
            finish = choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call' ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'content_filter' ? 'refusal' : 'other'
          }
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (ab.timedOut) throw new ProviderError(`${this.config.name}: stream stalled (no data for ${(req.idleTimeoutMs ?? 120000) / 1000}s)`, 'timeout')
        if ((e as Error).name === 'AbortError') throw new ProviderError('Request aborted', 'aborted', { retryable: false })
        throw networkError(e, this.config.name, url)
      }
      const tail = splitter.flush()
      if (tail.reasoning) yield { type: 'reasoning', delta: tail.reasoning }
      if (tail.text) yield { type: 'text', delta: tail.text }

      let anyCall = false
      for (const [idx, acc] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!acc.name) continue
        anyCall = true
        if (!acc.started) yield { type: 'tool_start', id: acc.id || `call_${idx}`, name: acc.name }
        const parsed = safeParseJson(acc.args)
        const id = acc.id || `call_${idx}_${Date.now().toString(36)}`
        yield parsed.ok ? { type: 'tool_call', id, name: acc.name, input: parsed.value } : { type: 'tool_call', id, name: acc.name, input: {}, parseError: parsed.error }
      }
      if (usage) yield { type: 'usage', input: usage.input, output: usage.output, cacheRead: usage.cacheRead }
      yield { type: 'finish', reason: anyCall && finish !== 'length' ? 'tool_calls' : finish === 'other' ? 'stop' : finish }
    } finally { ab.done() }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = joinUrl(this.config.baseUrl, 'models')
    const ab = makeAbort(signal, 20_000)
    try {
      let res: Response
      try { res = await httpFetch(url, { headers: this.headers(), signal: ab.signal }) } catch (e) { throw networkError(e, this.config.name, url) }
      if (!res.ok) throw await errorFromResponse(res, this.config.name)
      type Entry = { id: string; context_length?: number; context_window?: number; max_model_len?: number; architecture?: { input_modalities?: string[] } }
      const j = await res.json() as { data?: Entry[]; models?: { name: string }[] }
      const list: Entry[] = j.data ?? j.models?.map(m => ({ id: m.name })) ?? []
      return list.map(m => {
        const info = guessModelInfo(m.id)
        const ctx = m.context_length ?? m.context_window ?? m.max_model_len
        if (ctx) info.contextWindow = ctx
        if (m.architecture?.input_modalities?.includes('image')) info.vision = true
        return info
      }).filter(m => m.modality !== 'embedding' || true)
    } finally { ab.done() }
  }
}
