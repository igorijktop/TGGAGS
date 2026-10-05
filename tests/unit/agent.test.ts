import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOpenAI, type Script } from './helpers/mock-openai'
import { settings } from '../../electron/services/settings'
import { workspace } from '../../electron/services/workspace'
import { bus } from '../../electron/services/events'
import { runtime } from '../../electron/ai/runtime'
import { sessions } from '../../electron/ai/sessions'
import { snapshots } from '../../electron/ai/snapshots'
import type { AiEvent, Session } from '../../shared/ai'

let project: string

function setup(url: string) {
  settings.update({
    providers: [{ id: 'mock', name: 'Mock', protocol: 'openai', baseUrl: url, requiresKey: false, enabled: true, models: [{ id: 'mock-1', modality: 'chat', contextWindow: 32000, tools: true, vision: false }] }],
    ai: { defaultModel: { provider: 'mock', model: 'mock-1' }, permissionMode: 'auto-edit', maxRetries: 1, autoCompact: false }
  })
}

async function runTurn(text: string, opts: { onEvent?: (e: AiEvent) => void; sessionId?: string; mode?: 'ask' | 'auto-edit' | 'plan' | 'yolo'; agent?: string } = {}) {
  const events: AiEvent[] = []
  const handler = (e: AiEvent) => { events.push(e); opts.onEvent?.(e) }
  bus.on('ai:event', handler)
  const { sessionId } = await runtime.send({ text, sessionId: opts.sessionId, mode: opts.mode, agent: opts.agent })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for done; events=' + events.map(e => e.type).join(','))), 20000)
    const check = (e: AiEvent) => { if (e.type === 'done' && e.sessionId === sessionId) { clearTimeout(t); bus.off('ai:event', check); resolve() } }
    bus.on('ai:event', check)
  })
  bus.off('ai:event', handler)
  return { sessionId, events, session: sessions.get(sessionId)! as Session }
}

beforeAll(async () => {
  settings.init()
  project = mkdtempSync(join(tmpdir(), 'tgg-proj-'))
  writeFileSync(join(project, 'hello.txt'), 'Hello world\nsecond line\n')
  writeFileSync(join(project, '.env'), 'SECRET_KEY=abcdefghijklmnop1234567890\n')
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'main.ts'), 'export const x = 1\n')
  await workspace.open(project)
})
afterAll(async () => { await workspace.close() })

describe('agent loop', () => {
  it('reads, edits and writes files over multiple steps and reports the final answer', async () => {
    const script: Script[] = [
      { text: 'Let me look at the file.', tools: [{ name: 'read', args: { filePath: 'hello.txt' } }], usage: { prompt: 100, completion: 20 } },
      { tools: [{ name: 'edit', args: { filePath: 'hello.txt', oldString: 'Hello world', newString: 'Hello TGGAGS' } }, { name: 'write', args: { filePath: 'src/new.ts', content: 'export const y = 2\n' } }].slice(0, 1), usage: { prompt: 200, completion: 30 } },
      { tools: [{ name: 'write', args: { filePath: 'src/new.ts', content: 'export const y = 2\n' } }], usage: { prompt: 300, completion: 30 } },
      { text: 'Done: updated hello.txt and created src/new.ts.', usage: { prompt: 400, completion: 15 } }
    ]
    const mock = await startMockOpenAI(script)
    setup(mock.url)
    const { session, events } = await runTurn('Change the greeting in hello.txt and add src/new.ts')
    await mock.close()

    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('Hello TGGAGS\nsecond line\n')
    expect(readFileSync(join(project, 'src/new.ts'), 'utf8')).toBe('export const y = 2\n')
    const tools = session.messages.flatMap(m => m.parts).filter(p => p.type === 'tool')
    expect(tools.map(t => (t as { name: string }).name)).toEqual(['read', 'edit', 'write'])
    expect(tools.every(t => (t as { state: string }).state === 'completed')).toBe(true)
    const last = session.messages[session.messages.length - 1]
    expect(last.parts.some(p => p.type === 'text' && p.text.includes('Done'))).toBe(true)
    expect(events.some(e => e.type === 'delta')).toBe(true)
    expect(events.find(e => e.type === 'done')).toMatchObject({ reason: 'complete' })
    expect(session.usage.steps).toBe(4)
    expect(session.usage.input).toBe(1000)

    // the model received tool schemas and a system prompt on every call
    expect(mock.requests[0].tools.map((t: any) => t.function.name)).toContain('apply_patch')
    expect(mock.requests[0].messages[0].role).toBe('system')
    expect(mock.requests[0].messages[0].content).toContain(project)
    // tool results are fed back as tool messages
    const secondReq = mock.requests[1].messages
    expect(secondReq.some((m: any) => m.role === 'tool' && m.content.includes('Hello world'))).toBe(true)
  })

  it('undoes and redoes a whole turn of agent edits', async () => {
    const mock = await startMockOpenAI([
      { tools: [{ name: 'read', args: { filePath: 'hello.txt' } }] },
      { tools: [{ name: 'edit', args: { filePath: 'hello.txt', oldString: 'second line', newString: 'changed line' } }] },
      { text: 'ok' }
    ])
    setup(mock.url)
    const { sessionId } = await runTurn('edit it')
    await mock.close()
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toContain('changed line')
    const changes = await snapshots.summary(sessionId, project)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ rel: 'hello.txt', status: 'modified', added: 1, removed: 1 })
    const r = await snapshots.revertLastTurn(sessionId)
    expect(r.reverted).toBe(1)
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toContain('second line')
    await snapshots.redo(sessionId)
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toContain('changed line')
  })

  it('refuses to edit a file that was not read and explains why', async () => {
    const mock = await startMockOpenAI([
      { tools: [{ name: 'edit', args: { filePath: 'src/main.ts', oldString: 'x = 1', newString: 'x = 2' } }] },
      { text: 'I need to read first.' }
    ])
    setup(mock.url)
    const { session } = await runTurn('change x')
    await mock.close()
    const part = session.messages.flatMap(m => m.parts).find(p => p.type === 'tool') as { state: string; output: string }
    expect(part.state).toBe('error')
    expect(part.output).toMatch(/read .* before/i)
    expect(readFileSync(join(project, 'src/main.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('denies reading .env through the permission rules', async () => {
    const mock = await startMockOpenAI([{ tools: [{ name: 'read', args: { filePath: '.env' } }] }, { text: 'cannot' }])
    setup(mock.url)
    const { session } = await runTurn('show me secrets')
    await mock.close()
    const part = session.messages.flatMap(m => m.parts).find(p => p.type === 'tool') as { state: string; output: string }
    expect(part.state).toBe('denied')
    expect(part.output).toMatch(/Secrets|permission/i)
  })

  it('asks before running shell commands and respects approve / deny', async () => {
    const mock = await startMockOpenAI([
      { tools: [{ name: 'shell', args: { command: 'node -e "console.log(40+2)"', description: 'compute' } }] },
      { tools: [{ name: 'shell', args: { command: 'node -e "console.log(1)" && echo nope', description: 'second' } }] },
      { text: 'finished' }
    ])
    setup(mock.url)
    let asked = 0
    const { session } = await runTurn('run things', {
      mode: 'ask',
      onEvent: e => {
        if (e.type === 'permission_request') { asked++; runtime.answerPermission({ id: e.request.id, decision: asked === 1 ? 'once' : 'deny', feedback: asked === 2 ? 'not now' : undefined }) }
      }
    })
    await mock.close()
    expect(asked).toBe(2)
    const parts = session.messages.flatMap(m => m.parts).filter(p => p.type === 'tool') as { state: string; output: string }[]
    expect(parts[0].state).toBe('completed')
    expect(parts[0].output).toContain('42')
    expect(parts[1].state).toBe('denied')
    expect(parts[1].output).toContain('not now')
  })

  it('plan mode blocks edits', async () => {
    const mock = await startMockOpenAI([
      { tools: [{ name: 'write', args: { filePath: 'plan-mode.txt', content: 'x' } }] },
      { text: 'blocked' }
    ])
    setup(mock.url)
    const { session } = await runTurn('write a file', { mode: 'plan' })
    await mock.close()
    expect(existsSync(join(project, 'plan-mode.txt'))).toBe(false)
    const part = session.messages.flatMap(m => m.parts).find(p => p.type === 'tool') as { state: string }
    expect(part.state).toBe('denied')
  })

  it('retries transient provider errors and then succeeds', async () => {
    const mock = await startMockOpenAI([{ status: 503 }, { text: 'recovered' }])
    setup(mock.url)
    const { session } = await runTurn('hello retry')
    await mock.close()
    expect(mock.calls()).toBe(2)
    expect(session.messages[session.messages.length - 1].parts.some(p => p.type === 'text' && p.text === 'recovered')).toBe(true)
  })

  it('surfaces a helpful error for auth failures without retrying', async () => {
    const mock = await startMockOpenAI([{ status: 401, errorBody: { error: { message: 'bad key' } } }])
    setup(mock.url)
    const { events } = await runTurn('hello auth')
    await mock.close()
    expect(mock.calls()).toBe(1)
    const err = events.find(e => e.type === 'error') as { message: string } | undefined
    expect(err?.message).toMatch(/401/)
  })

  it('runs sub-agents and returns their report to the parent', async () => {
    const mock = await startMockOpenAI([
      (_b: any, n: number) => n === 0 ? { tools: [{ name: 'subagent', args: { agent: 'explore', description: 'find main', prompt: 'Find the main entry file and report its path.' } }] } : { text: '' },
      { text: 'Sub-agent report: the entry is src/main.ts' },
      { text: 'The explorer says the entry is src/main.ts.' }
    ])
    setup(mock.url)
    const { session, events } = await runTurn('where is main?')
    await mock.close()
    const sub = session.messages.flatMap(m => m.parts).find(p => p.type === 'tool' && p.name === 'subagent') as { state: string; output: string; meta?: { childSessionId?: string } }
    expect(sub.state).toBe('completed')
    expect(sub.output).toContain('src/main.ts')
    expect(sub.meta?.childSessionId).toBeTruthy()
    expect(sessions.get(sub.meta!.childSessionId!)?.parentId).toBe(session.id)
    expect(events.some(e => e.type === 'session' && e.session.parentId === session.id)).toBe(true)
  })

  it('maintains todos and nudges when items are left unfinished', async () => {
    const mock = await startMockOpenAI([
      { tools: [{ name: 'todowrite', args: { todos: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }] } }] },
      { text: 'Starting.' },
      { tools: [{ name: 'todowrite', args: { todos: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'completed' }] } }] },
      { text: 'All done.' }
    ])
    setup(mock.url)
    const { session } = await runTurn('do two steps')
    await mock.close()
    expect(session.todos.every(t => t.status === 'completed')).toBe(true)
    // the nudge was injected as a synthetic user message
    expect(session.messages.some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.synthetic && p.text.includes('unfinished')))).toBe(true)
  })

  it('stops with a message when the same tool call is repeated', async () => {
    const same = { tools: [{ name: 'grep', args: { pattern: 'zzz-not-there' } }] }
    const mock = await startMockOpenAI([same, same, same, same, same, same, { text: 'unreachable' }])
    setup(mock.url)
    const { session, events } = await runTurn('loop forever')
    await mock.close()
    expect(events.find(e => e.type === 'done')).toMatchObject({ reason: 'error' })
    expect(session.messages.some(m => m.notice && JSON.stringify(m.parts).includes('repeating'))).toBe(true)
  })

  it('compacts long history into a summary message', async () => {
    const mock = await startMockOpenAI([
      { text: 'first answer' }, { text: 'second answer' }, { text: 'Summary: user asked two things.' }
    ])
    setup(mock.url)
    const a = await runTurn('first question')
    const b = await runTurn('second question', { sessionId: a.sessionId })
    expect(b.session.messages.length).toBeGreaterThanOrEqual(4)
    const ok = await runtime.compactSession(a.sessionId)
    await mock.close()
    expect(ok).toBe(true)
    const s = sessions.get(a.sessionId)!
    expect(s.messages.some(m => m.summary)).toBe(true)
  })
})
