import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fsp } from 'node:fs'
import { dataDir } from '../../services/paths'
import { uid } from '../../services/storage'

export function resolvePath(root: string, cwd: string, p: string): string {
  const cleaned = p.trim().replace(/^["']|["']$/g, '')
  if (!cleaned) return cwd
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || isAbsolute(cleaned)) return resolve(cleaned)
  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) return resolve((process.env.USERPROFILE || process.env.HOME || root) + cleaned.slice(1))
  return resolve(cwd || root, cleaned)
}

export function insideRoot(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Path shown to the model/user: relative to the project when inside it. */
export function displayPath(root: string, p: string): string {
  if (!root) return p
  const rel = relative(root, p)
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p).split(sep).join('/')
}

export interface Truncated { text: string; truncated: boolean; savedTo?: string }

/** Cap tool output; the full text is saved to disk so the model can page through it with `read`. */
export async function truncateOutput(text: string, opts: { maxChars?: number; maxLines?: number; save?: boolean } = {}): Promise<Truncated> {
  const maxChars = opts.maxChars ?? 30_000
  const maxLines = opts.maxLines ?? 2000
  const lines = text.split('\n')
  if (text.length <= maxChars && lines.length <= maxLines) return { text, truncated: false }
  let out = lines.slice(0, maxLines).join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars)
  let savedTo: string | undefined
  if (opts.save !== false) {
    try {
      savedTo = join(dataDir('tool-output'), `${uid('out-')}.txt`)
      await fsp.writeFile(savedTo, text, 'utf8')
    } catch { savedTo = undefined }
  }
  const hint = savedTo ? ` Full output saved to ${savedTo} – use the read tool with offset/limit (or grep) to inspect it.` : ''
  return { text: `${out}\n\n… [output truncated: ${lines.length} lines, ${text.length} characters.${hint}]`, truncated: true, savedTo }
}

export function countLines(s: string): number { return s === '' ? 0 : s.split('\n').length }

export function similarNames(names: string[], target: string, limit = 5): string[] {
  const t = target.toLowerCase()
  return names.filter(n => n.toLowerCase().includes(t) || t.includes(n.toLowerCase())).slice(0, limit)
}

export function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }

export async function exists(p: string): Promise<boolean> { try { await fsp.access(p); return true } catch { return false } }
