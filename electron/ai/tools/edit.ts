// Fuzzy "find and replace" used by the edit tool. Models often get whitespace slightly wrong, so we try
// progressively looser strategies, but only accept a candidate when it is unambiguous.

type Replacer = (content: string, find: string) => Generator<string>

const SimpleReplacer: Replacer = function* (_content, find) { yield find }

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const original = content.split('\n')
  const search = find.split('\n')
  if (search[search.length - 1] === '') search.pop()
  for (let i = 0; i <= original.length - search.length; i++) {
    let ok = true
    for (let j = 0; j < search.length; j++) if (original[i + j].trim() !== search[j].trim()) { ok = false; break }
    if (!ok) continue
    let start = 0
    for (let k = 0; k < i; k++) start += original[k].length + 1
    let end = start
    for (let k = 0; k < search.length; k++) end += original[i + k].length + (k < search.length - 1 ? 1 : 0)
    yield content.substring(start, end)
  }
}

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  const m: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return m[a.length][b.length]
}

const BlockAnchorReplacer: Replacer = function* (content, find) {
  const original = content.split('\n')
  const search = find.split('\n')
  if (search.length < 3) return
  if (search[search.length - 1] === '') search.pop()
  const first = search[0].trim(), last = search[search.length - 1].trim()
  const candidates: { start: number; end: number }[] = []
  for (let i = 0; i < original.length; i++) {
    if (original[i].trim() !== first) continue
    for (let j = i + 2; j < original.length; j++) if (original[j].trim() === last) { candidates.push({ start: i, end: j }); break }
  }
  if (!candidates.length) return
  const sim = (s: number, e: number) => {
    const lines = Math.min(search.length - 2, e - s - 1)
    if (lines <= 0) return 1
    let total = 0
    for (let k = 1; k < search.length - 1 && k < e - s; k++) {
      const a = original[s + k].trim(), b = search[k].trim(), mx = Math.max(a.length, b.length)
      total += mx === 0 ? 1 : 1 - levenshtein(a, b) / mx
    }
    return total / lines
  }
  const threshold = candidates.length === 1 ? 0.5 : 0.8
  let best: { start: number; end: number } | null = null, bestSim = -1
  for (const c of candidates) { const s = sim(c.start, c.end); if (s > bestSim) { bestSim = s; best = c } }
  if (!best || bestSim < threshold) return
  let start = 0
  for (let k = 0; k < best.start; k++) start += original[k].length + 1
  let end = start
  for (let k = best.start; k <= best.end; k++) end += original[k].length + (k < best.end ? 1 : 0)
  yield content.substring(start, end)
}

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  const target = norm(find)
  const lines = content.split('\n')
  for (const line of lines) if (norm(line) === target) yield line
  const fl = find.split('\n')
  if (fl.length > 1) {
    for (let i = 0; i <= lines.length - fl.length; i++) {
      const block = lines.slice(i, i + fl.length).join('\n')
      if (norm(block) === target) yield block
    }
  }
}

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const strip = (t: string) => {
    const ls = t.split('\n')
    if (ls.every(l => l.trim() === '')) return t
    const min = Math.min(...ls.filter(l => l.trim()).map(l => l.match(/^(\s*)/)![1].length))
    return ls.map(l => (l.trim() ? l.slice(min) : l)).join('\n')
  }
  const target = strip(find)
  const lines = content.split('\n')
  const n = find.split('\n').length
  for (let i = 0; i <= lines.length - n; i++) {
    const block = lines.slice(i, i + n).join('\n')
    if (strip(block) === target) yield block
  }
}

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const t = find.trim()
  if (t === find) return
  if (content.includes(t)) yield t
}

const REPLACERS: Replacer[] = [SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer, WhitespaceNormalizedReplacer, IndentationFlexibleReplacer, TrimmedBoundaryReplacer]

export class EditMatchError extends Error {}

export function replaceContent(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) throw new EditMatchError('oldString and newString are identical – nothing to change.')
  const crlf = content.includes('\r\n')
  const c = crlf ? content.replace(/\r\n/g, '\n') : content
  const o = oldString.replace(/\r\n/g, '\n')
  const n = newString.replace(/\r\n/g, '\n')
  let foundMultiple = false
  for (const replacer of REPLACERS) {
    for (const search of replacer(c, o)) {
      const idx = c.indexOf(search)
      if (idx === -1) continue
      if (replaceAll) {
        const out = c.split(search).join(n)
        return crlf ? out.replace(/\n/g, '\r\n') : out
      }
      if (c.lastIndexOf(search) !== idx) { foundMultiple = true; continue }
      const out = c.substring(0, idx) + n + c.substring(idx + search.length)
      return crlf ? out.replace(/\n/g, '\r\n') : out
    }
  }
  if (foundMultiple) throw new EditMatchError('Found multiple matches for oldString. Include more surrounding lines to make it unique, or set replaceAll to true.')
  throw new EditMatchError('oldString was not found in the file. Re-read the file and copy the text exactly (including indentation).')
}
