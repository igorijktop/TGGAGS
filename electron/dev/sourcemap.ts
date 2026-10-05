// Tiny source-map reader (VLQ mappings) – enough to translate breakpoints and stack frames for TypeScript.
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

interface Segment { genCol: number; src: number; line: number; col: number }

export class SourceMap {
  sources: string[] = []
  private lines: Segment[][] = []

  constructor(raw: { sources: string[]; sourceRoot?: string; mappings: string }, baseDir: string) {
    this.sources = raw.sources.map(s => {
      let p = (raw.sourceRoot ? raw.sourceRoot.replace(/\/$/, '') + '/' : '') + s
      if (p.startsWith('file://')) { try { p = fileURLToPath(p) } catch { /* keep */ } }
      return isAbsolute(p) ? resolve(p) : resolve(baseDir, p)
    })
    let src = 0, line = 0, col = 0
    for (const lineStr of raw.mappings.split(';')) {
      const segs: Segment[] = []
      let genCol = 0
      for (const seg of lineStr.split(',')) {
        if (!seg) continue
        const vals: number[] = []
        let shift = 0, value = 0
        for (const ch of seg) {
          const d = B64_INDEX.get(ch) ?? 0
          value += (d & 31) << shift
          if (d & 32) shift += 5
          else { vals.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0 }
        }
        genCol += vals[0]
        if (vals.length >= 4) { src += vals[1]; line += vals[2]; col += vals[3]; segs.push({ genCol, src, line, col }) }
      }
      this.lines.push(segs)
    }
  }

  static parse(text: string, baseDir: string): SourceMap | null {
    try { return new SourceMap(JSON.parse(text), baseDir) } catch { return null }
  }

  /** generated (0-based) → original (0-based) */
  originalPositionFor(line: number, col: number): { source: string; line: number; col: number } | null {
    const segs = this.lines[line]
    if (!segs?.length) return null
    let best: Segment | null = null
    for (const s of segs) { if (s.genCol <= col) best = s; else break }
    best ??= segs[0]
    return { source: this.sources[best.src], line: best.line, col: best.col }
  }

  /** original (0-based line) → first generated position at or after that line */
  generatedPositionFor(source: string, origLine: number): { line: number; col: number } | null {
    const idx = this.sources.findIndex(s => s === source || s.toLowerCase() === source.toLowerCase())
    if (idx < 0) return null
    let best: { gl: number; gc: number; ol: number } | null = null
    for (let gl = 0; gl < this.lines.length; gl++) {
      for (const s of this.lines[gl]) {
        if (s.src !== idx || s.line < origLine) continue
        if (!best || s.line < best.ol || (s.line === best.ol && gl < best.gl)) best = { gl, gc: s.genCol, ol: s.line }
      }
    }
    return best ? { line: best.gl, col: best.gc } : null
  }
}

export function loadSourceMapFromUrl(mapUrl: string, scriptPath: string, read: (p: string) => string | null): SourceMap | null {
  const baseDir = dirname(scriptPath)
  if (mapUrl.startsWith('data:')) {
    const m = mapUrl.match(/^data:[^,]*;base64,(.*)$/)
    const text = m ? Buffer.from(m[1], 'base64').toString('utf8') : decodeURIComponent(mapUrl.slice(mapUrl.indexOf(',') + 1))
    return SourceMap.parse(text, baseDir)
  }
  let p = mapUrl
  if (p.startsWith('file://')) { try { p = fileURLToPath(p) } catch { return null } }
  else if (!isAbsolute(p)) p = resolve(baseDir, p)
  const text = read(p)
  return text ? SourceMap.parse(text, dirname(p)) : null
}
