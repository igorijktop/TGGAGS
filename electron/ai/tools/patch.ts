// apply_patch: supports the "*** Begin Patch" envelope (add / update / delete / move) and plain unified diffs.
import { ToolError } from './types'

export type PatchOp =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; chunks: Chunk[] }

export interface Chunk { header?: string; oldLines: string[]; newLines: string[]; eof?: boolean }

export function parsePatch(text: string): PatchOp[] {
  const src = text.replace(/\r\n/g, '\n').trim()
  if (/^\*\*\* Begin Patch/m.test(src)) return parseEnvelope(src)
  if (/^(---|\+\+\+) /m.test(src) || /^diff --git/m.test(src)) return parseUnified(src)
  throw new ToolError('Unrecognised patch format. Use the "*** Begin Patch" format or a unified diff.')
}

function parseEnvelope(src: string): PatchOp[] {
  const lines = src.split('\n')
  let i = lines.findIndex(l => l.startsWith('*** Begin Patch'))
  i++
  const ops: PatchOp[] = []
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('*** End Patch')) break
    let m: RegExpMatchArray | null
    if ((m = line.match(/^\*\*\* Add File: (.+)$/))) {
      const content: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('*** ')) { content.push(lines[i].startsWith('+') ? lines[i].slice(1) : lines[i]); i++ }
      ops.push({ type: 'add', path: m[1].trim(), content: content.join('\n') + (content.length ? '\n' : '') })
    } else if ((m = line.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ type: 'delete', path: m[1].trim() }); i++
    } else if ((m = line.match(/^\*\*\* Update File: (.+)$/))) {
      const op: PatchOp = { type: 'update', path: m[1].trim(), chunks: [] }
      i++
      if (lines[i]?.startsWith('*** Move to: ')) { op.moveTo = lines[i].slice('*** Move to: '.length).trim(); i++ }
      let cur: Chunk | null = null
      while (i < lines.length && !(lines[i].startsWith('*** ') && !lines[i].startsWith('*** End of File'))) {
        const l = lines[i]
        if (l.startsWith('@@')) {
          cur = { header: l.slice(2).trim() || undefined, oldLines: [], newLines: [] }
          op.chunks.push(cur)
        } else if (l.startsWith('*** End of File')) { if (cur) cur.eof = true }
        else {
          if (!cur) { cur = { oldLines: [], newLines: [] }; op.chunks.push(cur) }
          if (l.startsWith('+')) cur.newLines.push(l.slice(1))
          else if (l.startsWith('-')) cur.oldLines.push(l.slice(1))
          else if (l.startsWith(' ')) { cur.oldLines.push(l.slice(1)); cur.newLines.push(l.slice(1)) }
          else if (l === '') { cur.oldLines.push(''); cur.newLines.push('') }
          else throw new ToolError(`Malformed patch line in ${op.path}: "${l}". Every line in a hunk must start with " ", "+" or "-".`)
        }
        i++
      }
      ops.push(op)
    } else if (line.trim() === '') i++
    else throw new ToolError(`Unexpected line in patch: "${line}"`)
  }
  if (!ops.length) throw new ToolError('Patch contains no operations.')
  return ops
}

function parseUnified(src: string): PatchOp[] {
  const lines = src.split('\n')
  const ops: PatchOp[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('--- ')) { i++; continue }
    const from = lines[i].slice(4).trim().replace(/^a\//, '').replace(/\t.*$/, '')
    const to = (lines[i + 1] ?? '').slice(4).trim().replace(/^b\//, '').replace(/\t.*$/, '')
    i += 2
    const chunks: Chunk[] = []
    while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git')) {
      if (lines[i].startsWith('@@')) {
        const c: Chunk = { oldLines: [], newLines: [] }
        i++
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git')) {
          const l = lines[i]
          if (l.startsWith('+')) c.newLines.push(l.slice(1))
          else if (l.startsWith('-')) c.oldLines.push(l.slice(1))
          else if (l.startsWith('\\')) { /* no newline marker */ }
          else if (l.startsWith(' ') || l === '') { c.oldLines.push(l.slice(1)); c.newLines.push(l.slice(1)) }
          i++
        }
        chunks.push(c)
      } else i++
    }
    if (from === '/dev/null') ops.push({ type: 'add', path: to, content: chunks.flatMap(c => c.newLines).join('\n') + '\n' })
    else if (to === '/dev/null') ops.push({ type: 'delete', path: from })
    else ops.push({ type: 'update', path: to || from, moveTo: to && to !== from ? to : undefined, chunks })
  }
  if (!ops.length) throw new ToolError('Patch contains no file changes.')
  return ops
}

function findBlock(lines: string[], block: string[], from: number, eof?: boolean): number {
  if (block.length === 0) return eof ? lines.length : from
  const tries: ((a: string, b: string) => boolean)[] = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()]
  for (const eq of tries) {
    const start = eof ? Math.max(from, lines.length - block.length) : from
    for (let i = start; i <= lines.length - block.length; i++) {
      let ok = true
      for (let j = 0; j < block.length; j++) if (!eq(lines[i + j], block[j])) { ok = false; break }
      if (ok) return i
    }
  }
  return -1
}

export function applyChunks(original: string, chunks: Chunk[], path: string): string {
  const crlf = original.includes('\r\n')
  const text = crlf ? original.replace(/\r\n/g, '\n') : original
  const endsNl = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsNl) lines.pop()
  let cursor = 0
  for (const [n, chunk] of chunks.entries()) {
    if (chunk.header) {
      const h = lines.findIndex((l, idx) => idx >= cursor && l.includes(chunk.header!))
      if (h >= 0) cursor = h
    }
    let idx = findBlock(lines, chunk.oldLines, cursor, chunk.eof)
    if (idx < 0) idx = findBlock(lines, chunk.oldLines, 0, chunk.eof)
    if (idx < 0) {
      const preview = chunk.oldLines.slice(0, 3).join('\\n')
      throw new ToolError(`Could not apply hunk ${n + 1} to ${path}: the context lines were not found (starting with "${preview}"). Re-read the file and regenerate the patch.`)
    }
    lines.splice(idx, chunk.oldLines.length, ...chunk.newLines)
    cursor = idx + chunk.newLines.length
  }
  let out = lines.join('\n') + (endsNl || lines.length === 0 ? '\n' : '')
  if (!endsNl && original !== '' && !text.endsWith('\n')) out = lines.join('\n')
  return crlf ? out.replace(/\n/g, '\r\n') : out
}
