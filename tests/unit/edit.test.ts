import { describe, expect, it } from 'vitest'
import { replaceContent, EditMatchError } from '../../electron/ai/tools/edit'
import { applyChunks, parsePatch } from '../../electron/ai/tools/patch'

describe('replaceContent', () => {
  it('replaces an exact unique match', () => {
    expect(replaceContent('a\nb\nc\n', 'b', 'B')).toBe('a\nB\nc\n')
  })
  it('tolerates indentation differences', () => {
    const src = 'function f() {\n    return 1\n}\n'
    expect(replaceContent(src, 'function f() {\n  return 1\n}', 'function f() {\n  return 2\n}')).toContain('return 2')
  })
  it('rejects ambiguous matches unless replaceAll', () => {
    expect(() => replaceContent('x\nx\n', 'x', 'y')).toThrow(EditMatchError)
    expect(replaceContent('x\nx\n', 'x', 'y', true)).toBe('y\ny\n')
  })
  it('preserves CRLF line endings', () => {
    expect(replaceContent('a\r\nb\r\n', 'a\nb', 'a\nB')).toBe('a\r\nB\r\n')
  })
  it('throws when not found', () => {
    expect(() => replaceContent('hello', 'nope', 'x')).toThrow(/not found/)
  })
  it('matches blocks by their first and last lines', () => {
    const src = 'start\n  something old here\nend\n'
    expect(replaceContent(src, 'start\n  something older here\nend', 'start\nnew\nend')).toBe('start\nnew\nend\n')
  })
})

describe('apply_patch', () => {
  it('parses and applies an update hunk', () => {
    const ops = parsePatch('*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch')
    expect(ops).toHaveLength(1)
    const op = ops[0]
    if (op.type !== 'update') throw new Error('expected update')
    expect(applyChunks('one\ntwo\nthree\n', op.chunks, 'a.txt')).toBe('one\nTWO\nthree\n')
  })
  it('parses add and delete operations', () => {
    const ops = parsePatch('*** Begin Patch\n*** Add File: n.txt\n+hi\n+there\n*** Delete File: o.txt\n*** End Patch')
    expect(ops).toEqual([{ type: 'add', path: 'n.txt', content: 'hi\nthere\n' }, { type: 'delete', path: 'o.txt' }])
  })
  it('parses unified diffs', () => {
    const ops = parsePatch('--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n')
    const op = ops[0]
    if (op.type !== 'update') throw new Error('expected update')
    expect(applyChunks('a\nb\n', op.chunks, 'f.txt')).toBe('a\nc\n')
  })
  it('reports hunks that do not apply', () => {
    const op = parsePatch('*** Begin Patch\n*** Update File: a.txt\n@@\n-zzz\n+y\n*** End Patch')[0]
    if (op.type !== 'update') throw new Error('x')
    expect(() => applyChunks('abc\n', op.chunks, 'a.txt')).toThrow(/Could not apply/)
  })
})
