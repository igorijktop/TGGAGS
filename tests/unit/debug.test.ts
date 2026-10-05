import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settings } from '../../electron/services/settings'
import { workspace } from '../../electron/services/workspace'
import { bus } from '../../electron/services/events'
import { debuggerService } from '../../electron/dev/debug'
import { SourceMap } from '../../electron/dev/sourcemap'
import type { DebugSnapshot } from '../../shared/dev'

let dir: string, script: string

const waitFor = (pred: (s: DebugSnapshot) => boolean, ms = 15000) => new Promise<DebugSnapshot>((resolve, reject) => {
  const t = setTimeout(() => { bus.off('debug:state', h); reject(new Error('timeout waiting for debug state')) }, ms)
  const h = (s: DebugSnapshot) => { if (pred(s)) { clearTimeout(t); bus.off('debug:state', h); resolve(s) } }
  bus.on('debug:state', h)
  void debuggerService.snapshot().then(s => { if (pred(s)) { clearTimeout(t); bus.off('debug:state', h); resolve(s) } })
})

beforeAll(async () => {
  settings.init()
  dir = mkdtempSync(join(tmpdir(), 'tgg-dbg-'))
  script = join(dir, 'app.js')
  writeFileSync(script, `function compute(a, b) {\n  const sum = a + b\n  const obj = { sum, list: [1, 2, 3], name: 'tgg' }\n  return obj.sum * 2\n}\nconsole.log('start')\nconst r = compute(20, 22)\nconsole.log('result', r)\n`)
  await workspace.open(dir)
})
afterAll(async () => { await debuggerService.stop(); await workspace.close(); rmSync(dir, { recursive: true, force: true }) })

describe('Node debugger', () => {
  it('hits a breakpoint, inspects variables, steps and finishes', async () => {
    const out: string[] = []
    const onOut = (o: { text: string }) => out.push(o.text)
    bus.on('debug:output', onOut)
    await debuggerService.setBreakpoints(script, [{ id: 'b1', path: script, line: 4, enabled: true }])
    await debuggerService.start({ name: 't', type: 'node', request: 'launch', program: script }, true)
    const paused = await waitFor(s => s.state === 'paused')
    expect(paused.pauseReason).toBe('breakpoint')
    expect(paused.frames[0]).toMatchObject({ name: 'compute', line: 4 })
    expect(paused.frames[0].path.endsWith('app.js')).toBe(true)

    const local = paused.frames[0].scopes.find(s => s.name === 'Local')!
    const vars = await debuggerService.variables(local.ref)
    expect(vars.find(v => v.name === 'sum')?.value).toBe('42')
    const objVar = vars.find(v => v.name === 'obj')!
    expect(objVar.expandable).toBe(true)
    const props = await debuggerService.variables(objVar.ref!)
    expect(props.find(p => p.name === 'name')?.value).toBe('"tgg"')
    expect(props.find(p => p.name === 'list')?.value).toMatch(/Array\(3\)/)

    const ev = await debuggerService.evaluate('sum * 10 + obj.list.length', paused.frames[0].id)
    expect(ev.value).toBe('423')
    expect(ev.error).toBeFalsy()
    expect((await debuggerService.evaluate('nope.x', paused.frames[0].id)).error).toBe(true)

    await debuggerService.stepOut()
    const afterStep = await waitFor(s => s.state === 'paused' && s.frames[0]?.line !== 4)
    expect(afterStep.frames[0].line).toBeGreaterThanOrEqual(7)

    await debuggerService.resume()
    await waitFor(s => s.state === 'terminated' || s.state === 'inactive')
    bus.off('debug:output', onOut)
    expect(out.join('')).toContain('result 84')
  })

  it('supports conditional breakpoints and logpoints', async () => {
    const out: string[] = []
    const onOut = (o: { text: string }) => out.push(o.text)
    bus.on('debug:output', onOut)
    const loop = join(dir, 'loop.js')
    writeFileSync(loop, `for (let i = 0; i < 5; i++) {\n  const sq = i * i\n  void sq\n}\nconsole.log('done')\n`)
    await debuggerService.setBreakpoints(loop, [
      { id: 'c', path: loop, line: 3, enabled: true, condition: 'i === 3' },
      { id: 'l', path: loop, line: 2, enabled: true, logMessage: 'i is {i}' }
    ])
    await debuggerService.start({ name: 'loop', type: 'node', request: 'launch', program: loop }, true)
    const p = await waitFor(s => s.state === 'paused')
    const all = (await Promise.all(p.frames[0].scopes.filter(sc => !sc.expensive).map(sc => debuggerService.variables(sc.ref)))).flat()
    expect(all.find(v => v.name === 'i')?.value).toBe('3')
    await debuggerService.resume()
    await waitFor(s => s.state === 'terminated' || s.state === 'inactive')
    bus.off('debug:output', onOut)
    expect(out.join('')).toMatch(/i is 0[\s\S]*i is 3/)
  })
})

describe('source maps', () => {
  it('maps generated positions back to original TypeScript lines and vice versa', () => {
    // maps: gen line0 col0 -> src0 line0 col0 ; gen line1 col2 -> src0 line1 col0
    const sm = new SourceMap({ sources: ['a.ts'], mappings: 'AAAA;EACA' }, '/proj')
    expect(sm.originalPositionFor(1, 2)).toMatchObject({ source: '/proj/a.ts', line: 1 })
    expect(sm.generatedPositionFor('/proj/a.ts', 1)).toMatchObject({ line: 1 })
  })
})
