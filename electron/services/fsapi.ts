import { promises as fsp, constants as fsc } from 'node:fs'
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { dialog, shell, BrowserWindow } from 'electron'
import type { FileEntry, ReadFileResult } from '../../shared/fs'
import { mimeForPath } from '../../shared/languages'
import { workspace } from './workspace'
import { fileIndex } from './fileindex'

const MAX_TEXT_BYTES = 6 * 1024 * 1024

export function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function decodeBuffer(buf: Buffer): { content: string; encoding: 'utf8' | 'utf8bom' | 'utf16le' } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { content: buf.subarray(3).toString('utf8'), encoding: 'utf8bom' }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { content: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  return { content: buf.toString('utf8'), encoding: 'utf8' }
}

export function encodeText(content: string, encoding: string): Buffer {
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')])
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
  return Buffer.from(content, 'utf8')
}

export async function readTextFile(path: string): Promise<ReadFileResult> {
  const st = await fsp.stat(path)
  if (st.size > MAX_TEXT_BYTES) return { kind: 'tooLarge', path, size: st.size, mtime: st.mtimeMs }
  const buf = await fsp.readFile(path)
  if (isBinaryBuffer(buf)) return { kind: 'binary', path, size: st.size, mtime: st.mtimeMs, mime: mimeForPath(path) }
  const { content, encoding } = decodeBuffer(buf)
  const eol = /\r\n/.test(content.slice(0, 20000)) ? 'crlf' : 'lf'
  return { kind: 'text', path, content, encoding, eol, size: st.size, mtime: st.mtimeMs }
}

export function resolveInRoot(p: string): string {
  const root = workspace.root
  if (isAbsolute(p)) return resolve(p)
  return resolve(root ?? process.cwd(), p)
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function toRel(p: string, root = workspace.root): string {
  if (!root) return p.split(sep).join('/')
  const rel = relative(root, p)
  return (rel.startsWith('..') ? p : rel).split(sep).join('/')
}

async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = name
  for (let i = 1; i < 500; i++) {
    try { await fsp.access(join(dir, candidate), fsc.F_OK) } catch { return candidate }
    candidate = `${stem} copy${i > 1 ? ' ' + i : ''}${ext}`
  }
  return candidate
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false })
}

export const fsApi = {
  async readDir(path: string): Promise<FileEntry[]> {
    const entries = await fsp.readdir(path, { withFileTypes: true })
    const out: FileEntry[] = []
    await Promise.all(entries.map(async e => {
      const full = join(path, e.name)
      let size = 0, mtime = 0
      let isDir = e.isDirectory()
      try {
        const st = await fsp.stat(full)
        size = st.size; mtime = st.mtimeMs
        if (e.isSymbolicLink()) isDir = st.isDirectory()
      } catch { /* broken link */ }
      out.push({ name: e.name, path: full, isDir, isSymlink: e.isSymbolicLink(), size, mtime })
    }))
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.isDir ? -1 : 1))
    return out
  },
  readFile: (path: string) => readTextFile(path),
  async readFileBase64(path: string): Promise<{ base64: string; mime: string }> {
    const buf = await fsp.readFile(path)
    return { base64: buf.toString('base64'), mime: mimeForPath(path) }
  },
  async writeFile(path: string, content: string, encoding: string = 'utf8'): Promise<{ mtime: number; size: number }> {
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, encodeText(content, encoding))
    const st = await fsp.stat(path)
    return { mtime: st.mtimeMs, size: st.size }
  },
  async writeBase64(path: string, base64: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, Buffer.from(base64, 'base64'))
  },
  async stat(path: string): Promise<{ exists: boolean; isDir: boolean; size: number; mtime: number }> {
    try { const st = await fsp.stat(path); return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs } }
    catch { return { exists: false, isDir: false, size: 0, mtime: 0 } }
  },
  async createFile(path: string, content = ''): Promise<string> {
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, content, { flag: 'wx' })
    return path
  },
  async createDir(path: string): Promise<string> { await fsp.mkdir(path, { recursive: true }); return path },
  async rename(from: string, to: string): Promise<string> {
    try { await fsp.access(to); throw new Error(`"${basename(to)}" already exists`) } catch (e) { if ((e as Error).message.includes('already exists')) throw e }
    await fsp.mkdir(dirname(to), { recursive: true })
    await fsp.rename(from, to)
    return to
  },
  async delete(path: string, permanent = false): Promise<void> {
    if (!permanent) { try { await shell.trashItem(path); return } catch { /* fall through to rm */ } }
    await fsp.rm(path, { recursive: true, force: true })
  },
  async duplicate(path: string): Promise<string> {
    const dir = dirname(path)
    const name = await uniqueName(dir, basename(path))
    const dest = join(dir, name)
    await copyRecursive(path, dest)
    return dest
  },
  async copyTo(src: string, destDir: string): Promise<string> {
    const name = await uniqueName(destDir, basename(src))
    const dest = join(destDir, name)
    await copyRecursive(src, dest)
    return dest
  },
  async move(src: string, destDir: string): Promise<string> {
    const dest = join(destDir, basename(src))
    if (resolve(dest) === resolve(src)) return src
    await fsp.rename(src, dest)
    return dest
  },
  async reveal(path: string): Promise<void> { shell.showItemInFolder(path) },
  async openExternal(url: string): Promise<void> {
    if (!/^(https?|mailto):/i.test(url)) throw new Error('Only http(s) and mailto links can be opened')
    await shell.openExternal(url)
  },
  async openPath(path: string): Promise<void> { await shell.openPath(path) },
  async pickFolder(title = 'Open folder'): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  async pickFiles(title = 'Select files', filters?: { name: string; extensions: string[] }[], multi = true): Promise<string[]> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win!, { title, filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] })
    return r.canceled ? [] : r.filePaths
  },
  async pickSavePath(title: string, defaultPath?: string): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showSaveDialog(win!, { title, defaultPath })
    return r.canceled ? null : r.filePath ?? null
  },
  async listFiles(): Promise<string[]> {
    const root = workspace.root
    return root ? fileIndex.list(root) : []
  },
  home(): string { return process.env.USERPROFILE || process.env.HOME || '' }
}
