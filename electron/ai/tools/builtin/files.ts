import { z } from 'zod'
import { promises as fsp, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, extname, join } from 'node:path'
import picomatch from 'picomatch'
import { defineTool, ToolError, type ToolContext } from '../types'
import { displayPath, errMsg, resolvePath, truncateOutput, countLines } from '../util'
import { readTextFile, encodeText } from '../../../services/fsapi'
import { walkFiles } from '../../../services/fileindex'
import { grepFiles } from '../../../services/search'
import { diffSnippet, diffStats } from '../../diffutil'
import { replaceContent, EditMatchError } from '../edit'
import { applyChunks, parsePatch } from '../patch'
import { isImagePath, mimeForPath } from '../../../../shared/languages'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(5)}\t${l.length > 2000 ? l.slice(0, 2000) + '… [line truncated]' : l}`).join('\n')
}

async function readWindow(path: string, offset: number, limit: number): Promise<{ lines: string[]; total: number }> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  const lines: string[] = []
  let n = 0
  for await (const line of rl) { n++; if (n >= offset && lines.length < limit) lines.push(line) }
  return { lines, total: n }
}

// ───────────────────────────── read ─────────────────────────────
export const readTool = defineTool({
  name: 'read',
  category: 'read',
  readOnly: true,
  description: `Read a file from the project (text, code, or an image). Returns the content with line numbers (cat -n style).
- filePath may be absolute or relative to the project root.
- By default up to 2000 lines are returned; use offset (1-based line) and limit to page through long files.
- Reading a directory returns its listing.
- Always read a file before editing it.`,
  schema: z.object({
    filePath: z.string().describe('Path of the file to read'),
    offset: z.number().int().min(1).optional().describe('1-based line number to start from'),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines to return (default 2000)')
  }),
  describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.filePath)
    return { title: `Reading ${displayPath(ctx.root, abs)}`, checks: [{ isPath: true, category: 'read', resources: [abs], title: `Read ${displayPath(ctx.root, abs)}` }] }
  },
  async execute(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.filePath)
    const rel = displayPath(ctx.root, abs)
    let st
    try { st = await fsp.stat(abs) } catch {
      const dir = dirname(abs)
      let hint = ''
      try { const near = (await fsp.readdir(dir)).filter(n => n.toLowerCase().includes(basename(abs).toLowerCase().slice(0, 4))).slice(0, 5); if (near.length) hint = ` Did you mean: ${near.map(n => displayPath(ctx.root, join(dir, n))).join(', ')}?` } catch { /* dir missing */ }
      throw new ToolError(`File not found: ${rel}.${hint}`)
    }
    if (st.isDirectory()) return listDirectory(abs, ctx)
    if (isImagePath(abs) && extname(abs).toLowerCase() !== '.svg') {
      if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`Image is too large (${(st.size / 1048576).toFixed(1)} MB).`)
      const data = (await fsp.readFile(abs)).toString('base64')
      ctx.runtime.markRead(abs, st.mtimeMs)
      return { output: `Image ${rel} (${st.size} bytes) is attached.`, title: `Read ${rel}`, images: [{ mime: mimeForPath(abs), data, name: basename(abs) }], meta: { path: abs } }
    }
    const offset = i.offset ?? 1
    const limit = i.limit ?? 2000
    let lines: string[], total: number
    const res = await readTextFile(abs)
    if (res.kind === 'binary') throw new ToolError(`${rel} is a binary file (${res.mime}); it cannot be read as text.`)
    if (res.kind === 'tooLarge') {
      if (!i.offset && !i.limit) throw new ToolError(`${rel} is large (${(res.size / 1048576).toFixed(1)} MB). Use grep to locate what you need, or pass offset and limit to read a window.`)
      ;({ lines, total } = await readWindow(abs, offset, limit))
    } else {
      const all = res.content.split('\n')
      if (all[all.length - 1] === '') all.pop()
      total = all.length
      lines = all.slice(offset - 1, offset - 1 + limit)
      ctx.runtime.markRead(abs, res.mtime)
    }
    if (res.kind === 'tooLarge') ctx.runtime.markRead(abs, st.mtimeMs)
    if (total === 0) return { output: `(${rel} is empty)`, title: `Read ${rel}`, meta: { path: abs } }
    if (offset > total) throw new ToolError(`offset ${offset} is beyond the end of ${rel} (${total} lines).`)
    const end = offset - 1 + lines.length
    let out = numbered(lines, offset)
    if (end < total) out += `\n\n(Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.)`
    else if (offset > 1) out += `\n\n(End of file – ${total} lines total.)`
    const t = await truncateOutput(out, { maxChars: 60_000, maxLines: 6000, save: false })
    return { output: t.text, title: `Read ${rel}`, meta: { path: abs, truncated: t.truncated } }
  }
})

// ───────────────────────────── list ─────────────────────────────
async function listDirectory(abs: string, ctx: ToolContext, depth = 3): Promise<{ output: string; title: string }> {
  const files = await walkFiles(abs)
  const tree = new Map<string, Set<string>>()
  for (const f of files) {
    const parts = f.split('/')
    for (let d = 0; d < Math.min(parts.length, depth + 1); d++) {
      const dirKey = parts.slice(0, d).join('/')
      const name = parts[d] + (d < parts.length - 1 ? '/' : '')
      if (!tree.has(dirKey)) tree.set(dirKey, new Set())
      tree.get(dirKey)!.add(name)
      if (d >= depth) break
    }
  }
  const out: string[] = []
  let count = 0
  const walk = (dirKey: string, indent: number) => {
    const entries = [...(tree.get(dirKey) ?? [])].sort((a, b) => (a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1))
    for (const e of entries) {
      if (count++ > 600) return
      out.push(`${'  '.repeat(indent)}${e}`)
      if (e.endsWith('/') && indent < depth) walk(dirKey ? `${dirKey}/${e.slice(0, -1)}` : e.slice(0, -1), indent + 1)
    }
  }
  walk('', 1)
  const head = `${displayPath(ctx.root, abs) || '.'}/ (${files.length} files; .gitignore respected)`
  return { output: [head, ...out, count > 600 ? '… (listing truncated – list a subdirectory for more)' : ''].filter(Boolean).join('\n'), title: `Listed ${displayPath(ctx.root, abs) || '.'}` }
}

export const listTool = defineTool({
  name: 'list',
  category: 'read',
  readOnly: true,
  description: 'List the files and folders of a directory as a tree (3 levels deep). Respects .gitignore. Defaults to the project root.',
  schema: z.object({ path: z.string().optional().describe('Directory to list (default: project root)') }),
  describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    return { title: `Listing ${displayPath(ctx.root, abs) || '.'}`, checks: [{ isPath: true, category: 'read', resources: [abs], title: `List ${displayPath(ctx.root, abs) || '.'}` }] }
  },
  async execute(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    try { const st = await fsp.stat(abs); if (!st.isDirectory()) throw new ToolError(`${displayPath(ctx.root, abs)} is not a directory.`) } catch (e) { if (e instanceof ToolError) throw e; throw new ToolError(`Directory not found: ${displayPath(ctx.root, abs)}`) }
    return listDirectory(abs, ctx)
  }
})

// ───────────────────────────── glob ─────────────────────────────
export const globTool = defineTool({
  name: 'glob',
  category: 'read',
  readOnly: true,
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Returns paths sorted by most recently modified. Respects .gitignore.',
  schema: z.object({ pattern: z.string().describe('Glob pattern'), path: z.string().optional().describe('Directory to search in (default: project root)') }),
  describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    return { title: `Finding ${i.pattern}`, checks: [{ isPath: true, category: 'read', resources: [abs], title: `Search files in ${displayPath(ctx.root, abs) || '.'}` }] }
  },
  async execute(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    const files = await walkFiles(abs)
    const pat = i.pattern.replace(/\\/g, '/')
    const m = picomatch(pat.includes('/') ? pat : `**/${pat}`, { dot: true })
    const hits = files.filter(f => m(f))
    const withTime = await Promise.all(hits.slice(0, 2000).map(async f => ({ f, t: await fsp.stat(join(abs, f)).then(s => s.mtimeMs).catch(() => 0) })))
    withTime.sort((a, b) => b.t - a.t)
    const shown = withTime.slice(0, 200)
    if (!hits.length) return { output: `No files matched ${i.pattern}.`, title: `Found 0 files`, meta: { matches: 0 } }
    const lines = shown.map(x => displayPath(ctx.root, join(abs, x.f)))
    return { output: lines.join('\n') + (hits.length > shown.length ? `\n… and ${hits.length - shown.length} more (refine the pattern)` : ''), title: `Found ${hits.length} file${hits.length === 1 ? '' : 's'}`, meta: { matches: hits.length } }
  }
})

// ───────────────────────────── grep ─────────────────────────────
export const grepTool = defineTool({
  name: 'grep',
  category: 'read',
  readOnly: true,
  description: `Search file contents with a regular expression. Returns "path:line: text" matches grouped by file.
Use include to restrict by glob (e.g. "*.ts"). Set regex=false for a literal search. Respects .gitignore; binary files are skipped.`,
  schema: z.object({
    pattern: z.string().describe('Regular expression (or literal text when regex is false)'),
    path: z.string().optional().describe('Directory to search (default: project root)'),
    include: z.string().optional().describe('Glob filter such as "*.tsx" or "src/**"'),
    regex: z.boolean().optional().describe('Treat pattern as a regular expression (default true)'),
    caseSensitive: z.boolean().optional().describe('Case sensitive search (default false)'),
    context: z.number().int().min(0).max(10).optional().describe('Lines of context around each match'),
    filesOnly: z.boolean().optional().describe('Return only the file names that match')
  }),
  describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    return { title: `Searching "${i.pattern.length > 40 ? i.pattern.slice(0, 40) + '…' : i.pattern}"`, checks: [{ isPath: true, category: 'read', resources: [abs], title: `Search in ${displayPath(ctx.root, abs) || '.'}` }] }
  },
  async execute(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.path ?? '.')
    try { new RegExp(i.pattern) } catch (e) { if (i.regex !== false) throw new ToolError(`Invalid regular expression: ${errMsg(e)}`) }
    const r = await grepFiles({ root: ctx.root, dir: abs, pattern: i.pattern, isRegex: i.regex !== false, caseSensitive: !!i.caseSensitive, include: i.include, context: i.context, signal: ctx.signal })
    if (!r.total) return { output: `No matches for "${i.pattern}" (${r.filesSearched} files searched).`, title: 'No matches', meta: { matches: 0 } }
    const out: string[] = []
    if (i.filesOnly) out.push(...r.files.map(f => f.rel))
    else for (const f of r.files) {
      out.push(`${f.rel}:`)
      for (const m of f.matches) {
        for (const [k, b] of m.before.entries()) out.push(`  ${m.line - m.before.length + k}- ${b.slice(0, 300)}`)
        out.push(`  ${m.line}: ${m.text.trim().slice(0, 300)}`)
        for (const [k, a] of m.after.entries()) out.push(`  ${m.line + 1 + k}- ${a.slice(0, 300)}`)
      }
    }
    const text = await truncateOutput(out.join('\n') + (r.truncated ? '\n… (match limit reached – narrow the search)' : ''))
    return { output: `${r.total} match${r.total === 1 ? '' : 'es'} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}\n${text.text}`, title: `${r.total} match${r.total === 1 ? '' : 'es'}`, meta: { matches: r.total } }
  }
})

// ───────────────────────────── edit / write / apply_patch ─────────────────────────────
async function assertFresh(abs: string, ctx: ToolContext, rel: string): Promise<void> {
  const last = ctx.runtime.lastRead(abs)
  if (last === undefined) throw new ToolError(`You must read ${rel} before modifying it. Use the read tool first.`)
  const st = await fsp.stat(abs)
  if (st.mtimeMs > last + 1) throw new ToolError(`${rel} was modified after you last read it (by the user or another process). Read it again before editing.`)
}

async function currentText(abs: string): Promise<{ content: string; encoding: string } | null> {
  try {
    const r = await readTextFile(abs)
    if (r.kind === 'text') return { content: r.content, encoding: r.encoding }
    if (r.kind === 'binary') throw new ToolError(`${basename(abs)} is a binary file and cannot be edited as text.`)
    throw new ToolError(`${basename(abs)} is too large to edit with this tool.`)
  } catch (e) {
    if (e instanceof ToolError) throw e
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function commit(ctx: ToolContext, abs: string, before: string | null, after: string, encoding: string): Promise<void> {
  await fsp.mkdir(dirname(abs), { recursive: true })
  await fsp.writeFile(abs, encodeText(after, encoding))
  const st = await fsp.stat(abs)
  ctx.runtime.markRead(abs, st.mtimeMs)
  await ctx.runtime.recordChange({ path: abs, before, after, toolCallId: ctx.toolCallId })
}

interface EditPlan { abs: string; before: string | null; after: string; encoding: string }

export const editTool = defineTool({
  name: 'edit',
  category: 'edit',
  description: `Make a precise edit to an existing file by replacing exact text.
- oldString must match the file content exactly (whitespace included) and be unique; include a few surrounding lines for uniqueness, or set replaceAll to change every occurrence.
- Read the file first. Prefer edit over write for existing files.
- To create a new file, use write (or pass an empty oldString when the file does not exist).`,
  schema: z.object({
    filePath: z.string().describe('Path of the file to edit'),
    oldString: z.string().describe('The exact text to replace'),
    newString: z.string().describe('The replacement text (must differ from oldString)'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence of oldString')
  }),
  async describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.filePath)
    const rel = displayPath(ctx.root, abs)
    const cur = await currentText(abs)
    let after: string
    if (!cur) {
      if (i.oldString !== '') throw new ToolError(`File not found: ${rel}. Use write to create new files.`)
      after = i.newString
    } else {
      await assertFresh(abs, ctx, rel)
      if (i.oldString === '') throw new ToolError(`${rel} already exists; provide the oldString to replace, or use write to overwrite it.`)
      try { after = replaceContent(cur.content, i.oldString, i.newString, i.replaceAll) } catch (e) { if (e instanceof EditMatchError) throw new ToolError(`${e.message} (${rel})`); throw e }
    }
    const plan: EditPlan = { abs, before: cur?.content ?? null, after, encoding: cur?.encoding ?? 'utf8' }
    return { title: `Editing ${rel}`, plan, checks: [{ isPath: true, category: 'edit', resources: [abs], title: `Edit ${rel}`, preview: { kind: 'diff', path: rel, before: plan.before ?? '', after } }] }
  },
  async execute(i, ctx, plan) {
    const p = plan as EditPlan
    const rel = displayPath(ctx.root, p.abs)
    await commit(ctx, p.abs, p.before, p.after, p.encoding)
    const { added, removed } = diffStats(p.before ?? '', p.after)
    return {
      output: `Edited ${rel} (+${added} −${removed}).\n${diffSnippet(rel, p.before ?? '', p.after, 40)}`,
      title: `Edited ${rel}`, meta: { path: p.abs, diff: [{ path: rel, before: p.before ?? '', after: p.after, added, removed }] }
    }
  }
})

export const writeTool = defineTool({
  name: 'write',
  category: 'edit',
  description: `Create a new file or completely overwrite an existing one with the given content (parent folders are created).
For existing files you must read them first, and you should prefer the edit tool for small changes.`,
  schema: z.object({ filePath: z.string().describe('Path of the file to write'), content: z.string().describe('The full file content') }),
  async describe(i, ctx) {
    const abs = resolvePath(ctx.root, ctx.cwd, i.filePath)
    const rel = displayPath(ctx.root, abs)
    const cur = await currentText(abs)
    if (cur) await assertFresh(abs, ctx, rel)
    let after = i.content
    if (cur && cur.content.includes('\r\n') && !after.includes('\r\n')) after = after.replace(/\n/g, '\r\n')
    const plan: EditPlan = { abs, before: cur?.content ?? null, after, encoding: cur?.encoding ?? 'utf8' }
    return { title: `${cur ? 'Overwriting' : 'Creating'} ${rel}`, plan, checks: [{ isPath: true, category: 'edit', resources: [abs], title: `${cur ? 'Overwrite' : 'Create'} ${rel}`, preview: { kind: 'diff', path: rel, before: plan.before ?? '', after } }] }
  },
  async execute(_i, ctx, plan) {
    const p = plan as EditPlan
    const rel = displayPath(ctx.root, p.abs)
    await commit(ctx, p.abs, p.before, p.after, p.encoding)
    const { added, removed } = diffStats(p.before ?? '', p.after)
    return {
      output: `${p.before === null ? 'Created' : 'Wrote'} ${rel} (${countLines(p.after)} lines).`,
      title: `${p.before === null ? 'Created' : 'Wrote'} ${rel}`, meta: { path: p.abs, diff: [{ path: rel, before: p.before ?? '', after: p.after, added, removed }] }
    }
  }
})

interface PatchPlan { files: { abs: string; rel: string; before: string | null; after: string | null; encoding: string; moveTo?: string }[] }

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  category: 'edit',
  description: `Apply a multi-file patch atomically (all changes succeed or none). Format:
*** Begin Patch
*** Add File: path/new.ts
+first line
+second line
*** Update File: path/existing.ts
@@ optional line of context (e.g. a function header)
 unchanged context line
-line to remove
+line to add
*** Delete File: path/old.ts
*** End Patch
Hunk lines start with a space (context), "-" (remove) or "+" (add). Include ~3 lines of context around each change. A standard unified diff is also accepted.`,
  schema: z.object({ patchText: z.string().describe('The patch text') }),
  async describe(i, ctx) {
    const ops = parsePatch(i.patchText)
    const files: PatchPlan['files'] = []
    for (const op of ops) {
      const abs = resolvePath(ctx.root, ctx.cwd, op.path)
      const rel = displayPath(ctx.root, abs)
      const cur = await currentText(abs)
      if (op.type === 'add') {
        if (cur) throw new ToolError(`Cannot add ${rel}: it already exists.`)
        files.push({ abs, rel, before: null, after: op.content, encoding: 'utf8' })
      } else if (op.type === 'delete') {
        if (!cur) throw new ToolError(`Cannot delete ${rel}: file not found.`)
        files.push({ abs, rel, before: cur.content, after: null, encoding: cur.encoding })
      } else {
        if (!cur) throw new ToolError(`Cannot update ${rel}: file not found.`)
        await assertFresh(abs, ctx, rel)
        const after = applyChunks(cur.content, op.chunks, rel)
        files.push({ abs, rel, before: cur.content, after, encoding: cur.encoding, moveTo: op.moveTo ? resolvePath(ctx.root, ctx.cwd, op.moveTo) : undefined })
      }
    }
    const checks = files.flatMap(f => [
      { isPath: true, category: 'edit' as const, resources: [f.abs], title: `${f.after === null ? 'Delete' : f.before === null ? 'Create' : 'Patch'} ${f.rel}`, preview: { kind: 'diff' as const, path: f.rel, before: f.before ?? '', after: f.after ?? '' } },
      ...(f.moveTo ? [{ isPath: true, category: 'edit' as const, resources: [f.moveTo], title: `Move to ${displayPath(ctx.root, f.moveTo)}` }] : [])
    ])
    return { title: `Patching ${files.length} file${files.length === 1 ? '' : 's'}`, checks, plan: { files } satisfies PatchPlan }
  },
  async execute(_i, ctx, plan) {
    const { files } = plan as PatchPlan
    const diffs: NonNullable<import('../../../../shared/ai').ToolMeta['diff']> = []
    const lines: string[] = []
    for (const f of files) {
      if (f.after === null) {
        await ctx.runtime.recordChange({ path: f.abs, before: f.before, after: null, toolCallId: ctx.toolCallId })
        await fsp.rm(f.abs, { force: true })
        lines.push(`Deleted ${f.rel}`)
      } else {
        const target = f.moveTo ?? f.abs
        await commit(ctx, target, f.moveTo ? null : f.before, f.after, f.encoding)
        if (f.moveTo) { await ctx.runtime.recordChange({ path: f.abs, before: f.before, after: null, toolCallId: ctx.toolCallId }); await fsp.rm(f.abs, { force: true }) }
        lines.push(`${f.before === null ? 'Created' : f.moveTo ? 'Moved' : 'Updated'} ${displayPath(ctx.root, target)}`)
      }
      const st = diffStats(f.before ?? '', f.after ?? '')
      diffs.push({ path: f.rel, before: f.before ?? '', after: f.after ?? '', ...st })
    }
    return { output: `Patch applied:\n${lines.join('\n')}`, title: `Patched ${files.length} file${files.length === 1 ? '' : 's'}`, meta: { diff: diffs } }
  }
})
