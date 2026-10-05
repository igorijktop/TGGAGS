import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea/cache'])
const MAX_FILES = 150_000

interface Frame { base: string; ig: Ignore }

async function loadIgnore(dir: string): Promise<Ignore | null> {
  try {
    const text = await fsp.readFile(join(dir, '.gitignore'), 'utf8')
    return ignore().add(text)
  } catch { return null }
}

export interface WalkOptions {
  /** also include files matched by .gitignore */
  includeIgnored?: boolean
  /** skip directories by name in addition to the defaults */
  skipDirs?: Set<string>
  signal?: AbortSignal
}

/** Walks a workspace, honouring nested .gitignore files. Returns POSIX-style relative paths. */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const out: string[] = []
  const rootIg = await loadIgnore(root)
  const stack0: Frame[] = rootIg ? [{ base: root, ig: rootIg }] : []

  async function visit(dir: string, frames: Frame[]): Promise<void> {
    if (out.length >= MAX_FILES || opts.signal?.aborted) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    let local = frames
    if (dir !== root) {
      const ig = await loadIgnore(dir)
      if (ig) local = [...frames, { base: dir, ig }]
    }
    const subdirs: string[] = []
    for (const e of entries) {
      const full = join(dir, e.name)
      const isDir = e.isDirectory()
      if (isDir && (SKIP_DIRS.has(e.name) || opts.skipDirs?.has(e.name))) continue
      if (!isDir && !e.isFile() && !e.isSymbolicLink()) continue
      if (!opts.includeIgnored) {
        let ignored = false
        for (const f of local) {
          const rel = relative(f.base, full).split(sep).join('/')
          if (rel && f.ig.ignores(isDir ? rel + '/' : rel)) { ignored = true; break }
        }
        if (ignored) continue
      }
      if (isDir) subdirs.push(full)
      else out.push(relative(root, full).split(sep).join('/'))
    }
    for (const d of subdirs) await visit(d, local)
  }

  await visit(root, stack0)
  return out
}

class FileIndexService {
  private cache = new Map<string, { at: number; files: string[]; pending?: Promise<string[]> }>()

  async list(root: string, maxAgeMs = 20_000): Promise<string[]> {
    const c = this.cache.get(root)
    if (c && Date.now() - c.at < maxAgeMs) return c.files
    if (c?.pending) return c.pending
    const pending = walkFiles(root).then(files => { this.cache.set(root, { at: Date.now(), files }); return files })
    this.cache.set(root, { at: c?.at ?? 0, files: c?.files ?? [], pending })
    return pending
  }

  invalidate(root?: string): void {
    if (root) { const c = this.cache.get(root); if (c) c.at = 0 } else for (const c of this.cache.values()) c.at = 0
  }
}

export const fileIndex = new FileIndexService()
