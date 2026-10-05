import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const workerPath = resolve('dist-electron/ts-worker.cjs')
process.env.TGG_TS_WORKER = workerPath

import { settings } from '../../electron/services/settings'
import { workspace } from '../../electron/services/workspace'
import { lsp } from '../../electron/dev/lsp'

let dir: string
let a: string, b: string

beforeAll(async () => {
  if (!existsSync(workerPath)) execSync('node scripts/build-main.mjs', { stdio: 'ignore' })
  settings.init()
  dir = mkdtempSync(join(tmpdir(), 'tgg-lsp-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }))
  a = join(dir, 'src', 'a.ts'); b = join(dir, 'src', 'b.ts')
  writeFileSync(a, 'export function add(x: number, y: number): number {\n  return x + y\n}\nexport class Greeter { greet(name: string) { return `hi ${name}` } }\n')
  writeFileSync(b, "import { add, Greeter } from './a'\nconst total: string = add(1, 2)\nnew Greeter().greet('x')\nconsole.log(total, add(3, 4))\n")
  await workspace.open(dir)
  await lsp.reset(dir)
})
afterAll(async () => { lsp.shutdown(); await workspace.close(); rmSync(dir, { recursive: true, force: true }) })

describe('TypeScript language service (worker)', () => {
  it('reports semantic diagnostics', async () => {
    const d = await lsp.diagnostics(b)
    const err = d.find(x => x.severity === 'error')
    expect(err?.message).toMatch(/not assignable to type 'string'/)
    expect(err?.line).toBe(2)
  })
  it('goes to definition across files and finds references', async () => {
    const def = await lsp.definition(b, { line: 4, col: 21 }) // add in add(3, 4)
    expect(def[0].path).toBe(a)
    expect(def[0].line).toBe(1)
    const refs = await lsp.references(a, { line: 1, col: 18 })
    expect(refs.length).toBeGreaterThanOrEqual(3)
    expect(refs.some(r => r.path === b)).toBe(true)
  })
  it('provides hover, completions, signature help and symbols', async () => {
    const h = await lsp.hover(b, { line: 4, col: 21 })
    expect(h?.contents).toContain('add(x: number, y: number): number')
    await lsp.open(b, "import { add } from './a'\nadd(\nconst z = Math.\n", 'typescript', 5)
    const sig = await lsp.signatureHelp(b, { line: 2, col: 5 })
    expect(sig?.signatures[0].label).toContain('add(x: number, y: number)')
    const c = await lsp.completion(b, { line: 3, col: 16 })
    expect(c.items.map(i => i.label)).toContain('floor')
    const syms = await lsp.documentSymbols(a)
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['add', 'Greeter']))
    const ws = await lsp.workspaceSymbols('Greeter')
    expect(ws.some(s => s.name === 'Greeter')).toBe(true)
  })
  it('renames symbols across files', async () => {
    await lsp.open(b, "import { add, Greeter } from './a'\nconst total: string = add(1, 2)\nnew Greeter().greet('x')\nconsole.log(total, add(3, 4))\n", 'typescript', 6)
    const edits = await lsp.rename(a, { line: 1, col: 18 }, 'sum')
    expect(edits.map(e => e.path).sort()).toEqual([a, b].sort())
    expect(edits.every(e => e.edits.every(x => x.newText.includes('sum')))).toBe(true)
  })
  it('call hierarchy and post-edit diagnostics', async () => {
    const items = await lsp.callHierarchy(a, { line: 1, col: 18 }, 'prepare')
    expect(items[0].name).toBe('add')
    const incoming = await lsp.callHierarchy(a, { line: 1, col: 18 }, 'incoming', items[0])
    expect(incoming.length).toBeGreaterThan(0)
    writeFileSync(a, 'export function add(x: number, y: number): number {\n  return x + "oops"\n}\n')
    const msg = await lsp.diagnosticsAfterEdit([a])
    expect(msg).toMatch(/a\.ts:2/)
  })
})
