import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider } from '../../electron/ai/providers/anthropic'
import { GoogleProvider, geminiSchema } from '../../electron/ai/providers/google'
import { OpenAIProvider } from '../../electron/ai/providers/openai'
import { ThinkSplitter, safeParseJson } from '../../electron/ai/providers/http'
import type { ChatMessage, StreamEvent } from '../../electron/ai/providers/types'
import type { ProviderConfig } from '../../shared/settings'

async function server(handler: (body: any, req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: { body: any; headers: http.IncomingHttpHeaders; url: string }[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => { const body = raw ? JSON.parse(raw) : {}; seen.push({ body, headers: req.headers, url: req.url ?? '' }); handler(body, req, res) })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()) }) }
}

const collect = async (g: AsyncGenerator<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of g) out.push(e); return out }
const sse = (res: http.ServerResponse, events: [string | null, unknown][]) => {
  res.setHeader('content-type', 'text/event-stream')
  for (const [ev, data] of events) res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const cfg = (protocol: ProviderConfig['protocol'], baseUrl: string, name = 'T'): ProviderConfig => ({ id: 't', name, protocol, baseUrl, requiresKey: false, enabled: true, models: [] })
const user = (t: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: t }] })

describe('Anthropic provider (official SDK)', () => {
  const stream = (res: http.ServerResponse, stop: string, extra: [string | null, unknown][] = []) => sse(res, [
    ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 30 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ...extra,
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 42 } }],
    ['message_stop', { type: 'message_stop' }]
  ])

  it('streams text, reasoning with signature, tool_use and usage; sends adaptive thinking without sampling params', async () => {
    const s = await server((_b, _r, res) => stream(res, 'tool_use', [
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"filePath":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }]
    ]))
    const p = new AnthropicProvider(cfg('anthropic', s.base + '/v1'), 'key')
    const ev = await collect(p.streamChat({ model: 'claude-sonnet-5-5', modelInfo: { id: 'claude-sonnet-5-5', modality: 'chat', reasoning: true, vision: true, maxOutput: 128000 }, system: 'sys', messages: [user('hi')], tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }], temperature: 0.3, reasoning: 'high', showReasoning: true }))
    await s.close()
    expect(ev.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toBe('Hello world')
    expect(ev.find(e => e.type === 'reasoning_block')).toMatchObject({ signature: 'SIG123' })
    expect(ev.find(e => e.type === 'tool_call')).toMatchObject({ id: 'toolu_1', name: 'read', input: { filePath: 'a.ts' } })
    expect(ev.find(e => e.type === 'usage')).toMatchObject({ input: 150, output: 42, cacheRead: 30 })
    expect(ev[ev.length - 1]).toMatchObject({ type: 'finish', reason: 'tool_calls' })
    const body = s.seen[0].body
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body.stream).toBe(true)
    expect(s.seen[0].headers['x-api-key']).toBe('key')
    expect(s.seen[0].headers.authorization).toBe('Bearer key') // gateways get a bearer token too
    expect(s.seen[0].url).toBe('/v1/messages')
    expect(body.cache_control).toBeUndefined() // only on api.anthropic.com
  })

  it('uses budget_tokens only on pre-adaptive models and echoes thinking blocks only inside the current tool loop', async () => {
    const s = await server((_b, _r, res) => stream(res, 'end_turn'))
    const p = new AnthropicProvider(cfg('anthropic', s.base + '/v1'), 'key')
    const msgs: ChatMessage[] = [
      user('old question'),
      { role: 'assistant', text: 'old answer', reasoning: [{ text: 'old', signature: 'OLD' }] },
      user('new question'),
      { role: 'assistant', text: '', reasoning: [{ text: 'thinking', signature: 'CUR' }], toolCalls: [{ id: 'toolu_9', name: 'read', input: { filePath: 'x' } }] },
      { role: 'tool', toolCallId: 'toolu_9', name: 'read', content: 'file text' }
    ]
    await collect(p.streamChat({ model: 'claude-haiku-4-5', modelInfo: { id: 'claude-haiku-4-5', modality: 'chat', reasoning: true }, messages: msgs, reasoning: 'medium', temperature: 0.2 }))
    await s.close()
    const b = s.seen[0].body
    expect(b.thinking).toMatchObject({ type: 'enabled' })
    expect(b.thinking.budget_tokens).toBeLessThan(b.max_tokens)
    expect(b).not.toHaveProperty('temperature') // thinking enabled → no temperature
    const flat = JSON.stringify(b.messages)
    expect(flat).toContain('CUR')
    expect(flat).not.toContain('OLD')
    // tool_result is delivered as a user message block
    const last = b.messages[b.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9' })
  })

  it('reports refusals with their category and maps errors', async () => {
    const s = await server((_b, _r, res) => sse(res, [
      ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 5, output_tokens: 0 } } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }]
    ]))
    const p = new AnthropicProvider(cfg('anthropic', s.base), 'k')
    const ev = await collect(p.streamChat({ model: 'claude-opus-5-5', messages: [user('x')] }))
    await s.close()
    expect(ev[ev.length - 1]).toMatchObject({ type: 'finish', reason: 'refusal', detail: 'cyber: nope' })

    const bad = await server((_b, _r, res) => { res.statusCode = 429; res.setHeader('retry-after', '2'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })) })
    const p2 = new AnthropicProvider(cfg('anthropic', bad.base), 'k')
    await expect(collect(p2.streamChat({ model: 'claude-opus-5-5', messages: [user('x')] }))).rejects.toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 })
    await bad.close()
  })
})

describe('OpenAI-compatible provider', () => {
  it('parses text, <think> tags, incremental tool calls, usage; uses max_completion_tokens for reasoning models', async () => {
    const s = await server((_b, _r, res) => sse(res, [
      [null, { choices: [{ delta: { content: '<think>plan</th' } }] }],
      [null, { choices: [{ delta: { content: 'ink>Answer' } }] }],
      [null, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{"pattern":' } }] } }] }],
      [null, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }],
      [null, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
      [null, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } }]
    ]))
    const p = new OpenAIProvider(cfg('openai', s.base + '/v1'), 'sk-test')
    const ev = await collect(p.streamChat({ model: 'gpt-5', messages: [user('hi')], maxTokens: 500, temperature: 0.5, reasoning: 'high', tools: [{ name: 'grep', description: 'd', parameters: { type: 'object' } }] }))
    await s.close()
    expect(ev.filter(e => e.type === 'reasoning').map(e => (e as { delta: string }).delta).join('')).toBe('plan')
    expect(ev.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toBe('Answer')
    expect(ev.find(e => e.type === 'tool_call')).toMatchObject({ name: 'grep', input: { pattern: 'x' } })
    expect(ev.find(e => e.type === 'usage')).toMatchObject({ input: 11, output: 7, cacheRead: 4 })
    const b = s.seen[0].body
    expect(b.max_completion_tokens).toBe(500)
    expect(b.max_tokens).toBeUndefined()
    expect(b.temperature).toBeUndefined()
    expect(b.reasoning_effort).toBe('high')
    expect(s.seen[0].headers.authorization).toBe('Bearer sk-test')
  })

  it('retries without optional parameters when a local server rejects them', async () => {
    let n = 0
    const s = await server((b, _r, res) => {
      n++
      if (b.stream_options) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } })); return }
      sse(res, [[null, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]])
    })
    const p = new OpenAIProvider(cfg('openai', s.base + '/v1'), undefined)
    const ev = await collect(p.streamChat({ model: 'llama3', messages: [user('x')] }))
    await s.close()
    expect(n).toBe(2)
    expect(ev.some(e => e.type === 'text')).toBe(true)
  })

  it('classifies network failures', async () => {
    const p = new OpenAIProvider(cfg('openai', 'http://127.0.0.1:1/v1'), undefined)
    await expect(collect(p.streamChat({ model: 'x', messages: [user('x')] }))).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('Gemini provider', () => {
  it('maps function calls, thoughts and usage; echoes thought signatures', async () => {
    const s = await server((_b, _r, res) => sse(res, [
      [null, { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Hi' }] } }] }],
      [null, { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { filePath: 'a' } }, thoughtSignature: 'TS' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }]
    ]))
    const p = new GoogleProvider(cfg('google', s.base + '/v1beta'), 'gk')
    const msgs: ChatMessage[] = [user('hi'), { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: { filePath: 'b' }, providerMeta: { thoughtSignature: 'PREV' } }] }, { role: 'tool', toolCallId: 'c1', name: 'read', content: 'text' }]
    const ev = await collect(p.streamChat({ model: 'gemini-2.5-flash', modelInfo: { id: 'gemini-2.5-flash', modality: 'chat', reasoning: true }, messages: msgs, reasoning: 'medium', tools: [{ name: 'read', description: 'd', parameters: { type: 'object', additionalProperties: false, properties: { filePath: { type: ['string', 'null'] } } } }] }))
    await s.close()
    expect(ev.find(e => e.type === 'reasoning')).toBeTruthy()
    expect(ev.find(e => e.type === 'tool_call')).toMatchObject({ name: 'read', input: { filePath: 'a' }, providerMeta: { thoughtSignature: 'TS' } })
    expect(ev.find(e => e.type === 'usage')).toMatchObject({ input: 9, output: 5 })
    expect(ev[ev.length - 1]).toMatchObject({ type: 'finish', reason: 'tool_calls' })
    const b = s.seen[0].body
    expect(s.seen[0].url).toContain('gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(s.seen[0].headers['x-goog-api-key']).toBe('gk')
    expect(b.contents[1].parts[0]).toMatchObject({ functionCall: { name: 'read' }, thoughtSignature: 'PREV' })
    expect(b.contents[2].role).toBe('user')
    expect(b.contents[2].parts[0].functionResponse.name).toBe('read')
    expect(b.tools[0].functionDeclarations[0].parameters.properties.filePath).toEqual({ type: 'string', nullable: true })
    expect(b.generationConfig.thinkingConfig.includeThoughts).toBe(true)
  })
  it('converts JSON schema to the Gemini subset', () => {
    expect(geminiSchema({ type: 'object', additionalProperties: false, $schema: 'x', properties: { a: { type: 'array', items: { type: 'integer' }, default: [] } } })).toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } } })
  })
})

describe('helpers', () => {
  it('ThinkSplitter handles tags split across chunks', () => {
    const t = new ThinkSplitter()
    const a = t.push('hello <thi'); const b = t.push('nk>secret</think> world')
    expect(a.text + b.text + t.flush().text).toBe('hello  world')
    expect(b.reasoning).toBe('secret')
  })
  it('safeParseJson never repairs truncated JSON', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(safeParseJson('{"a":"trunc').ok).toBe(false)
    expect(safeParseJson('').ok).toBe(true)
  })
})
