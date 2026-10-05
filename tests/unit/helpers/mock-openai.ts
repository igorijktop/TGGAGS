import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ScriptedTool { name: string; args: unknown }
export interface Scripted { text?: string; reasoning?: string; tools?: ScriptedTool[]; usage?: { prompt: number; completion: number }; status?: number; errorBody?: unknown; finish?: string }
export type Script = Scripted | ((body: any, call: number) => Scripted)

/** A tiny OpenAI-compatible /chat/completions server that replays scripted responses and records requests. */
export async function startMockOpenAI(script: Script[]) {
  const requests: any[] = []
  let n = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-embed-1' }] })); return }
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      requests.push(body)
      const idx = Math.min(n, script.length - 1)
      const s0 = script[idx]
      const s = typeof s0 === 'function' ? s0(body, n) : s0
      n++
      if (s.status && s.status >= 400) { res.statusCode = s.status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(s.errorBody ?? { error: { message: `mock error ${s.status}` } })); return }
      res.setHeader('content-type', 'text/event-stream')
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model }
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
      if (s.reasoning) send({ ...base, choices: [{ index: 0, delta: { reasoning_content: s.reasoning } }] })
      if (s.text) for (let i = 0; i < s.text.length; i += 7) send({ ...base, choices: [{ index: 0, delta: { content: s.text.slice(i, i + 7) } }] })
      s.tools?.forEach((t, ti) => {
        const args = JSON.stringify(t.args)
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: ti, id: `call_${n}_${ti}`, type: 'function', function: { name: t.name, arguments: '' } }] } }] })
        for (let i = 0; i < args.length; i += 11) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: ti, function: { arguments: args.slice(i, i + 11) } }] } }] })
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: s.finish ?? (s.tools?.length ? 'tool_calls' : 'stop') }] })
      if (s.usage) send({ ...base, choices: [], usage: { prompt_tokens: s.usage.prompt, completion_tokens: s.usage.completion } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()) }), calls: () => n }
}
