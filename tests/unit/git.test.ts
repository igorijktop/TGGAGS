import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settings } from '../../electron/services/settings'
import { workspace } from '../../electron/services/workspace'
import { gitApi, parseStatus } from '../../electron/dev/git'

let dir: string
const w = (f: string, c: string) => writeFileSync(join(dir, f), c)

beforeAll(async () => {
  settings.init()
  dir = mkdtempSync(join(tmpdir(), 'tgg-git-'))
  await workspace.open(dir)
  await gitApi.init()
  await gitApi.setIdentity('Test User', 'test@example.com')
})
afterAll(async () => { await workspace.close(); rmSync(dir, { recursive: true, force: true }) })

describe('git service', () => {
  it('parses porcelain v2 status including renames and untracked files', () => {
    const out = ['# branch.oid abcdef1234567890', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/a b.ts', '2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts', 'old.ts', '? untracked.txt', ''].join('\0')
    const s = parseStatus(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(s.files[0]).toMatchObject({ path: 'src/a b.ts', unstaged: true, staged: false })
    expect(s.files[1]).toMatchObject({ path: 'new.ts', origPath: 'old.ts', staged: true })
    expect(s.files[2]).toMatchObject({ path: 'untracked.txt', untracked: true })
  })

  it('stages, commits, diffs and logs', async () => {
    w('a.txt', 'one\n')
    let st = await gitApi.status()
    expect(st.isRepo).toBe(true)
    expect(st.files).toHaveLength(1)
    expect(st.files[0].untracked).toBe(true)
    await gitApi.stage(['a.txt'])
    st = await gitApi.status()
    expect(st.files[0]).toMatchObject({ staged: true, index: 'A' })
    const sides = await gitApi.diffSides('a.txt', 'staged')
    expect(sides).toMatchObject({ original: '', modified: 'one\n' })
    await gitApi.commit({ message: 'first commit\n\nbody text' })
    w('a.txt', 'one\ntwo\n')
    const un = await gitApi.diffSides('a.txt', 'unstaged')
    expect(un).toMatchObject({ original: 'one\n', modified: 'one\ntwo\n' })
    await gitApi.stage(['a.txt'])
    await gitApi.unstage(['a.txt'])
    expect((await gitApi.status()).files[0]).toMatchObject({ staged: false, unstaged: true })
    await gitApi.discard(['a.txt'])
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    const log = await gitApi.log()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ subject: 'first commit', body: 'body text', author: 'Test User' })
    const detail = await gitApi.show(log[0].hash)
    expect(detail.files).toEqual([{ status: 'A', path: 'a.txt', oldPath: undefined, added: 1, removed: 0 }])
  })

  it('creates and switches branches, stashes, and resolves a merge conflict', async () => {
    const main = (await gitApi.status()).branch!
    await gitApi.checkout('feature', true)
    w('a.txt', 'feature change\n'); await gitApi.stageAll(); await gitApi.commit({ message: 'feature' })
    await gitApi.checkout(main)
    w('a.txt', 'main change\n'); await gitApi.stageAll(); await gitApi.commit({ message: 'main' })
    const branches = await gitApi.branches()
    expect(branches.map(b => b.name)).toEqual(expect.arrayContaining([main, 'feature']))
    expect(branches.find(b => b.current)?.name).toBe(main)

    const out = await gitApi.merge('feature')
    expect(out).toMatch(/CONFLICT/)
    let st = await gitApi.status()
    expect(st.merging).toBe(true)
    expect(st.files.find(f => f.conflict)?.path).toBe('a.txt')
    const sides = await gitApi.conflictSides('a.txt')
    expect(sides).toMatchObject({ ours: 'main change\n', theirs: 'feature change\n' })
    expect(sides.merged).toContain('<<<<<<<')
    await gitApi.resolveConflict('a.txt', 'both')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('main change')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('feature change')
    await gitApi.commit({ message: 'merge feature' })
    st = await gitApi.status()
    expect(st.merging).toBe(false)

    w('b.txt', 'stash me\n'); await gitApi.stage(['b.txt'])
    await gitApi.stashPush('wip stuff')
    expect((await gitApi.stashList())[0].message).toContain('wip stuff')
    expect((await gitApi.status()).files).toHaveLength(0)
    await gitApi.stashApply(0, true)
    expect((await gitApi.status()).files.map(f => f.path)).toContain('b.txt')
    expect(await gitApi.stashList()).toHaveLength(0)
  })

  it('reports blame', async () => {
    const b = await gitApi.blame('a.txt')
    expect(b.length).toBeGreaterThan(0)
    expect(b[0].author).toBe('Test User')
  })
})
