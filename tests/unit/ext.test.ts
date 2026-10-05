import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { zipSync, strToU8 } from 'fflate'
import { settings } from '../../electron/services/settings'
import { workspace } from '../../electron/services/workspace'
import { mcp } from '../../electron/ai/../ext/mcp'
import { extensions } from '../../electron/ext/extensions'
import { allTools, findTool } from '../../electron/ai/tools/registry'
import { generateImages, assets, imageApi } from '../../electron/media/images'
import { benchApi } from '../../electron/ai/bench'
import { runtime } from '../../electron/ai/runtime'
import type { ToolContext } from '../../electron/ai/tools/types'
import { startMockOpenAI } from './helpers/mock-openai'

let dir: string
const deps = { skills: () => [], subagents: () => [] }
const ctx = (): ToolContext => ({ sessionId: 's', agent: { id: 'build', name: 'Build', description: '', mode: 'primary', prompt: '', tools: ['*'] }, root: dir, cwd: dir, signal: new AbortController().signal, toolCallId: 't1', settings: settings.get(), runtime: {} as never })
const waitFor = async (pred: () => boolean, ms = 15000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)) } }

beforeAll(async () => {
  settings.init()
  dir = mkdtempSync(join(tmpdir(), 'tgg-ext-'))
  await workspace.open(dir)
  mcp.init(); extensions.init()
})
afterAll(async () => { mcp.shutdown(); await workspace.close(); rmSync(dir, { recursive: true, force: true }) })

describe('MCP', () => {
  it('connects to a stdio server, registers its tools and executes them', async () => {
    await mcp.save('test', { command: process.execPath, args: [resolve('tests/unit/helpers/mcp-server.mjs')] }, 'global')
    await waitFor(() => allTools(deps).some(t => t.name === 'mcp__test__add'))
    const list = await mcp.list()
    const s = list.find(x => x.name === 'test')!
    expect(s.status).toBe('connected')
    expect(s.tools.map(t => t.name).sort()).toEqual(['add', 'fail'])
    expect(s.serverInfo?.name).toBe('test-server')
    const tool = findTool(allTools(deps), 'mcp__test__add')!
    expect(tool.category).toBe('mcp')
    expect(tool.validate({ a: 1 })).toMatchObject({ ok: false })
    const res = await tool.execute({ a: 2, b: 40 }, ctx())
    expect(res.output).toBe('42')
    const bad = await findTool(allTools(deps), 'mcp__test__fail')!.execute({}, ctx())
    expect(bad.isError).toBe(true)
    expect(await mcp.readResource('test', 'test://greeting')).toBe('hello from resource')
    await mcp.remove('test')
    expect(allTools(deps).some(t => t.name === 'mcp__test__add')).toBe(false)
  })
  it('reports connection errors for missing commands', async () => {
    await mcp.save('broken', { command: 'definitely-not-a-real-command-xyz' }, 'global')
    await waitFor(() => { const s = (mcp as any).states.get('broken'); return s?.status === 'error' })
    expect((await mcp.list()).find(x => x.name === 'broken')?.error).toBeTruthy()
    await mcp.remove('broken')
  })
})

describe('extensions and custom tools', () => {
  it('installs the bundled example extension and runs its tools, commands and themes', async () => {
    process.env.TGG_NOOP = '1'
    const bundled = await extensions.bundled()
    expect(bundled.map(b => b.id)).toEqual(expect.arrayContaining(['hello-tools', 'theme-pack', 'git-helpers']))
    const info = await extensions.installBundled('hello-tools')
    expect(info.active).toBe(true)
    expect(info.tools).toEqual(expect.arrayContaining(['hello-tools__word_count', 'hello-tools__uuid']))
    writeFileSync(join(dir, 'a.txt'), 'one two\nthree\n')
    const t = findTool(allTools(deps), 'hello-tools__word_count')!
    expect(t.category).toBe('plugin')
    expect((await t.execute({ path: 'a.txt' }, ctx())).output).toBe('a.txt: 3 lines, 3 words, 14 characters'.replace('3 lines', '3 lines'))
    expect((await findTool(allTools(deps), 'hello-tools__slugify')!.execute({ text: 'Hello, World & Co!' }, ctx())).output).toBe('hello-world-co')

    await extensions.installBundled('theme-pack')
    const themes = await extensions.themes()
    expect(themes.map(x => x.id)).toEqual(expect.arrayContaining(['dracula', 'nord', 'solarized-light']))
    expect(themes.find(x => x.id === 'dracula')!.ui['--accent']).toBe('#BD93F9')
    expect(themes.find(x => x.id === 'dracula')!.ui['--success']).toBeTruthy() // inherited from base

    await extensions.setEnabled('hello-tools', false)
    expect(allTools(deps).some(x => x.name.startsWith('hello-tools__'))).toBe(false)
    await extensions.setEnabled('hello-tools', true)
    expect(allTools(deps).some(x => x.name.startsWith('hello-tools__'))).toBe(true)
    await extensions.uninstall('hello-tools')
    expect((await extensions.list()).some(x => x.id === 'hello-tools')).toBe(false)
  })

  it('installs from a zip archive and rejects invalid ones', async () => {
    const zip = zipSync({ 'my-ext/tgg-extension.json': strToU8(JSON.stringify({ id: 'zipped', name: 'Zipped', version: '1.0.0', main: 'index.js' })), 'my-ext/index.js': strToU8("exports.activate = t => t.tools.register({ name: 'ping', description: 'ping', execute: async () => 'pong' })") })
    const zp = join(dir, 'ext.zip'); writeFileSync(zp, zip)
    const info = await extensions.installFromZip(zp)
    expect(info.id).toBe('zipped'); expect(info.active).toBe(true)
    expect((await findTool(allTools(deps), 'zipped__ping')!.execute({}, ctx())).output).toBe('pong')
    writeFileSync(join(dir, 'bad.zip'), zipSync({ 'readme.txt': strToU8('x') }))
    await expect(extensions.installFromZip(join(dir, 'bad.zip'))).rejects.toThrow(/tgg-extension/)
    await extensions.uninstall('zipped')
  })

  it('loads project custom tools from .tgg/tools (json command + js)', async () => {
    mkdirSync(join(dir, '.tgg', 'tools'), { recursive: true })
    writeFileSync(join(dir, '.tgg', 'tools', 'say.json'), JSON.stringify({ name: 'say_hi', description: 'Print a greeting', parameters: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] }, command: 'node -e "console.log(process.argv[1])" {{who}}' }))
    writeFileSync(join(dir, '.tgg', 'tools', 'calc.js'), "module.exports = { name: 'double', description: 'Double a number', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async a => String(a.n * 2) }")
    await extensions.loadCustomTools()
    const say = findTool(allTools(deps), 'say_hi')!
    expect(say.category).toBe('custom')
    const d = await say.describe({ who: "O'Brien; rm -rf /" }, ctx())
    const out = await say.execute({ who: "O'Brien; rm -rf /" }, ctx(), d.plan)
    expect(out.output).toContain("O'Brien; rm -rf /") // the value was quoted, not interpreted
    expect((await findTool(allTools(deps), 'double')!.execute({ n: 21 }, ctx())).output).toBe('42')
  })
})

describe('images, assets, benchmarks', () => {
  it('generates images through an OpenAI-compatible endpoint and stores them as assets', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64').toString('base64')
    let body: any
    const srv = http.createServer((req, res) => { let raw = ''; req.on('data', d => { raw += d }); req.on('end', () => { body = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png, revised_prompt: 'a red cube, studio light' }] })) }) })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`
    settings.update({ providers: [{ id: 'img', name: 'Img', protocol: 'openai', baseUrl: base, requiresKey: false, enabled: true, models: [{ id: 'gpt-image-1', modality: 'image' }] }] })
    const made = await generateImages({ mode: 'generate', model: { provider: 'img', model: 'gpt-image-1' }, prompt: 'a red cube', size: '1024x1024', quality: 'high' })
    srv.close()
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a red cube', size: '1024x1024', quality: 'high' })
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ kind: 'generated', width: 1, height: 1, prompt: 'a red cube, studio light' })
    expect(existsSync(assets.pathOf(made[0]))).toBe(true)
    expect((await imageApi.listAssets()).some(a => a.id === made[0].id)).toBe(true)
    const saved = await imageApi.saveToProject(made[0].id, 'art/cube.png')
    expect(existsSync(saved)).toBe(true)
    await imageApi.deleteAsset(made[0].id)
    expect(await assets.get(made[0].id)).toBeNull()
  })

  it('benchmarks models and records latency, tokens and pass/fail', async () => {
    const mock = await startMockOpenAI([(b: any) => b.tools ? { tools: [{ name: 'get_weather', args: { city: 'Paris' } }], usage: { prompt: 20, completion: 10 } } : { text: '{"name":"Tom","tags":["a","b","c"]}', usage: { prompt: 20, completion: 12 } }])
    settings.update({ providers: [{ id: 'mock', name: 'Mock', protocol: 'openai', baseUrl: mock.url, requiresKey: false, enabled: true, models: [{ id: 'mock-1', modality: 'chat', inputPrice: 1, outputPrice: 2, tools: true }] }] })
    const res = await benchApi.run({ models: [{ provider: 'mock', model: 'mock-1' }], caseIds: ['json', 'tool-call', 'reasoning'] })
    await mock.close()
    expect(res).toHaveLength(3)
    expect(res.find(r => r.caseId === 'json')).toMatchObject({ ok: true, passed: true, inputTokens: 20, outputTokens: 12 })
    expect(res.find(r => r.caseId === 'tool-call')?.passed).toBe(true)
    expect(res.find(r => r.caseId === 'reasoning')?.passed).toBe(false)
    expect(res[0].ttftMs).toBeGreaterThanOrEqual(0)
    expect(res[0].cost).toBeGreaterThan(0)
    expect((await benchApi.results()).length).toBeGreaterThanOrEqual(3)
  })

  it('runtime helper model resolves from settings', async () => {
    const cand = await runtime.helperModel({ provider: 'mock', model: 'mock-1' })
    expect(cand?.ref.model).toBe('mock-1')
  })
})
