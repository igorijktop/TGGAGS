// A tiny OpenAI-compatible server used by the e2e/screenshot scripts. It plays a scripted "agent" conversation:
// it reads the project, edits a file, runs a command and finally answers with rich Markdown.
import http from 'node:http'

export async function startMock({ delay = 12 } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); return }
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {}
      requests.push(body)
      const msgs = body.messages ?? []
      let lastUser = -1
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break }
      const step = msgs.filter(m => m.role === 'tool').length
      const userText = typeof msgs[lastUser]?.content === 'string' ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? '')
      const isTitle = /title/i.test(msgs[0]?.content ?? '') && msgs.length <= 2 && !body.tools
      res.setHeader('content-type', 'text/event-stream')
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model }
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const text = async t => { for (let i = 0; i < t.length; i += 9) { send({ ...base, choices: [{ index: 0, delta: { content: t.slice(i, i + 9) } }] }); await sleep(delay) } }
      const think = async t => { for (let i = 0; i < t.length; i += 12) { send({ ...base, choices: [{ index: 0, delta: { reasoning_content: t.slice(i, i + 12) } }] }); await sleep(delay) } }
      const tools = list => list.forEach((t, ti) => {
        const args = JSON.stringify(t.args)
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: ti, id: `call_${requests.length}_${ti}`, type: 'function', function: { name: t.name, arguments: '' } }] } }] })
        for (let i = 0; i < args.length; i += 17) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: ti, function: { arguments: args.slice(i, i + 17) } }] } }] })
      })
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
      if (isTitle) { await text('Add a greeting helper'); send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); return res.end() }
      let finish = 'stop'
      if (step === 0) {
        await think('The user wants a greeting helper. Let me look at the project layout and the existing entry point first, then add the function and verify it runs.')
        await text('I’ll start by looking at how the project is laid out.\n')
        tools([{ name: 'todowrite', args: { todos: [{ id: '1', content: 'Read the project', status: 'in_progress' }, { id: '2', content: 'Add the greet() helper', status: 'pending' }, { id: '3', content: 'Run it to verify', status: 'pending' }] } }, { name: 'read', args: { path: 'package.json' } }, { name: 'read', args: { path: 'src/index.js' } }])
        finish = 'tool_calls'
      } else if (step === 3) {
        await text('Now I’ll add the helper to `src/index.js`.\n')
        tools([{ name: 'edit', args: { path: 'src/index.js', old_string: "console.log('hello')", new_string: "export function greet(name) {\n  return `Hello, ${name}!`\n}\n\nconsole.log(greet('world'))" } }])
        finish = 'tool_calls'
      } else if (step === 4) {
        tools([{ name: 'shell', args: { command: 'node src/index.js', description: 'Run the entry point' } }])
        finish = 'tool_calls'
      } else if (step === 5) {
        tools([{ name: 'todowrite', args: { todos: [{ id: '1', content: 'Read the project', status: 'completed' }, { id: '2', content: 'Add the greet() helper', status: 'completed' }, { id: '3', content: 'Run it to verify', status: 'completed' }] } }])
        finish = 'tool_calls'
      } else {
        await text("Done — I added a `greet()` helper to `src/index.js` and verified it prints the expected greeting.\n\n## What changed\n\n- **`src/index.js`** now exports `greet(name)` and uses it for the default message\n- The entry point prints `Hello, world!`\n\n| File | Change |\n| --- | --- |\n| `src/index.js` | new `greet()` export |\n\n```js\nimport { greet } from './src/index.js'\nconsole.log(greet('Ada')) // Hello, Ada!\n```\n\nWant me to add a unit test for it as well?")
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
      send({ ...base, choices: [], usage: { prompt_tokens: 1800 + step * 400, completion_tokens: 120 + step * 30 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }) }
}
