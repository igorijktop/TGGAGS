import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions } from '../../shared/update'
import type { UpdateState } from '../../shared/update'
import { Updater } from '../../electron/services/update-core'

const installer = Buffer.alloc(300_000, 7)
const sha = createHash('sha256').update(installer).digest('hex')
let server: http.Server, base = '', manifest: Record<string, unknown> | string | null, file: Buffer, hits: string[]

beforeEach(async () => {
  manifest = { version: '1.2.0', file: 'Setup.exe', sha256: sha, size: installer.length, notes: '## New\n- faster' }
  file = installer; hits = []
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/latest.json')) { if (manifest === null) { res.statusCode = 404; return res.end() } return res.end(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)) }
    if (req.url?.startsWith('/Setup.exe')) { res.setHeader('content-length', file.length); return res.end(file) }
    res.statusCode = 404; res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))

function make(version = '1.0.0', urls = () => [`${base}/latest.json`], platform: NodeJS.Platform = 'win32') {
  const states: UpdateState[] = [], launched: string[] = [], revealed: string[] = []
  const u = new Updater({ version, fetch, dir: mkdtempSync(join(tmpdir(), 'tgg-upd-')), manifestUrls: urls, platform, emit: s => states.push(s), launch: f => launched.push(f), reveal: f => revealed.push(f) })
  return { u, states, launched, revealed, dir: () => (u as unknown as { d: { dir: string } }).d.dir }
}

describe('versions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('v2.0.0', '1.99.99')).toBeGreaterThan(0)
  })
})

describe('update check', () => {
  it('offers a newer release with its notes', async () => {
    const { u } = make()
    const s = await u.check(true)
    expect(s.status).toBe('available')
    if (s.status === 'available') { expect(s.info.version).toBe('1.2.0'); expect(s.info.notes).toContain('faster'); expect(s.info.url).toBe(`${base}/Setup.exe`) }
  })
  it('stays idle when already up to date or ahead', async () => {
    expect((await make('1.2.0').u.check(true)).status).toBe('idle')
    expect((await make('2.0.0').u.check(true)).status).toBe('idle')
  })
  it('takes the newest of several manifests and skips broken ones', async () => {
    const other = http.createServer((_q, r) => r.end(JSON.stringify({ version: '1.5.0', file: 'Setup.exe', sha256: sha, size: installer.length })))
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r))
    const o = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    const s = await make('1.0.0', () => [`${base}/missing.json`, `${base}/latest.json`, `${o}/latest.json`]).u.check(true)
    other.close()
    expect(s.status === 'available' && s.info.version).toBe('1.5.0')
  })
  it('rejects malformed manifests and reports it only for manual checks', async () => {
    manifest = { version: '9.9.9', file: 'Setup.exe', sha256: 'nope', size: 5 }
    const a = make()
    expect((await a.u.check(false)).status).toBe('idle')
    expect((await make().u.check(true)).status).toBe('error')
  })
  it('refuses installers on plain http to a real host', async () => {
    manifest = { version: '3.0.0', file: 'http://example.com/Setup.exe', sha256: sha, size: 10 }
    expect((await make().u.check(true)).status).toBe('error')
  })
  it('reports an unreachable server', async () => {
    const s = await make('1.0.0', () => ['http://127.0.0.1:1/latest.json']).u.check(true)
    expect(s.status).toBe('error')
  })
})

describe('download + install', () => {
  it('downloads, verifies the checksum, reports progress and starts the installer', async () => {
    const m = make()
    await m.u.check(true)
    const s = await m.u.download()
    expect(s.status).toBe('ready')
    expect(m.states.some(x => x.status === 'downloading')).toBe(true)
    expect(readdirSync(m.dir()).filter(f => f.endsWith('.exe'))).toHaveLength(1)
    expect(m.u.install()).toBe('launched')
    expect(m.launched[0]).toMatch(/TGGAGS-IDE-Setup-1\.2\.0\.exe$/)
  })
  it('throws away a damaged download', async () => {
    const m = make()
    await m.u.check(true)
    file = Buffer.alloc(installer.length, 9)
    const s = await m.u.download()
    expect(s.status).toBe('error')
    expect(readdirSync(m.dir())).toHaveLength(0)
    expect(() => m.u.install()).toThrow()
    file = installer
    expect((await m.u.download()).status).toBe('ready') // retry works from the error state
  })
  it('reuses an already downloaded installer', async () => {
    const m = make()
    await m.u.check(true); await m.u.download()
    const before = hits.filter(h => h.startsWith('/Setup.exe')).length
    const m2 = new Updater({ ...(m.u as unknown as { d: ConstructorParameters<typeof Updater>[0] }).d, emit: () => undefined })
    await m2.check(true)
    expect((await m2.download()).status).toBe('ready')
    expect(hits.filter(h => h.startsWith('/Setup.exe')).length).toBe(before)
  })
  it('can be cancelled', async () => {
    const m = make()
    await m.u.check(true)
    file = Buffer.alloc(30_000_000, 1); manifest = { ...(manifest as object), size: file.length, sha256: createHash('sha256').update(file).digest('hex') }
    await m.u.check(true)
    const p = m.u.download()
    setTimeout(() => m.u.cancel(), 5)
    const s = await p
    expect(['available', 'ready']).toContain(s.status)
  })
  it('only shows the file on platforms without an installer', async () => {
    const m = make('1.0.0', undefined, 'linux')
    await m.u.check(true); await m.u.download()
    expect(m.u.install()).toBe('revealed')
    expect(m.revealed).toHaveLength(1)
    expect(existsSync(m.revealed[0])).toBe(true)
  })
})
