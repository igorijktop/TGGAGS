import { z } from 'zod'
import { defineTool, ToolError } from '../types'
import { displayPath, resolvePath, truncateOutput } from '../util'
import { lsp } from '../../../dev/lsp'
import { languageForPath } from '../../../../shared/languages'
import type { LspCallItem, LspLocation, LspSymbol } from '../../../../shared/dev'

const fmtLoc = (root: string, l: LspLocation) => `${displayPath(root, l.path)}:${l.line}:${l.col}${l.preview ? `   ${l.preview}` : ''}`
const fmtSym = (root: string, s: LspSymbol, indent = 0): string[] => [
  `${'  '.repeat(indent)}${s.kind} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${s.path ? displayPath(root, s.path) + ':' : 'line '}${s.line}`,
  ...(s.children ?? []).flatMap(c => fmtSym(root, c, indent + 1))
]
const fmtCall = (root: string, c: LspCallItem) => `${c.kind} ${c.name} — ${displayPath(root, c.path)}:${c.selection.line}:${c.selection.col}${c.detail ? ` (${c.detail})` : ''}`

export const lspTool = defineTool({
  name: 'lsp',
  category: 'lsp',
  readOnly: true,
  timeoutMs: 60_000,
  description: `Code intelligence from language servers (TypeScript/JavaScript built in; Python, Go, Rust, C/C++ when their servers are installed). More precise than grep for navigating code.
Operations:
- goToDefinition, goToImplementation, findReferences, hover: need filePath + line + character (1-based, as shown by the read tool)
- documentSymbol: outline of a file (filePath)
- workspaceSymbol: search symbols across the project (query)
- prepareCallHierarchy, incomingCalls, outgoingCalls: who calls a function / what it calls (filePath + line + character)
- diagnostics: current errors and warnings of a file (filePath)`,
  schema: z.object({
    operation: z.enum(['goToDefinition', 'goToImplementation', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'diagnostics']),
    filePath: z.string().optional().describe('File to inspect'),
    line: z.number().int().min(1).optional().describe('1-based line'),
    character: z.number().int().min(1).optional().describe('1-based column'),
    query: z.string().optional().describe('Search text for workspaceSymbol')
  }),
  describe(i, ctx) {
    const abs = i.filePath ? resolvePath(ctx.root, ctx.cwd, i.filePath) : ctx.root
    return { title: `${i.operation}${i.filePath ? ' ' + displayPath(ctx.root, abs) : ''}${i.line ? `:${i.line}` : ''}`, checks: [{ isPath: true, category: 'lsp', resources: [abs], title: `Language server: ${i.operation}` }] }
  },
  async execute(i, ctx) {
    const root = ctx.root
    if (i.operation === 'workspaceSymbol') {
      if (!i.query) throw new ToolError('query is required for workspaceSymbol.')
      if (i.filePath) await lsp.ensureOpen(resolvePath(root, ctx.cwd, i.filePath))
      const syms = await lsp.workspaceSymbols(i.query)
      if (!syms.length) return { output: `No symbols matching "${i.query}". (Language servers only know files of languages they handle; open or reference one source file first, or use grep.)` }
      return { output: (await truncateOutput(syms.slice(0, 60).flatMap(s => fmtSym(root, s)).join('\n'), { save: false })).text, title: `${syms.length} symbols` }
    }
    if (!i.filePath) throw new ToolError(`filePath is required for ${i.operation}.`)
    const path = resolvePath(root, ctx.cwd, i.filePath)
    if (languageForPath(path) === 'plaintext') throw new ToolError(`No language server handles ${displayPath(root, path)}.`)
    const need = ['goToDefinition', 'goToImplementation', 'findReferences', 'hover', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls']
    if (need.includes(i.operation) && (!i.line || !i.character)) throw new ToolError(`line and character (1-based) are required for ${i.operation}.`)
    const pos = { line: i.line ?? 1, col: i.character ?? 1 }
    let out = ''
    switch (i.operation) {
      case 'goToDefinition': { const r = await lsp.definition(path, pos); out = r.length ? r.map(l => fmtLoc(root, l)).join('\n') : 'No definition found.'; break }
      case 'goToImplementation': { const r = await lsp.implementation(path, pos); out = r.length ? r.map(l => fmtLoc(root, l)).join('\n') : 'No implementations found.'; break }
      case 'findReferences': { const r = await lsp.references(path, pos); out = r.length ? `${r.length} references:\n` + r.slice(0, 150).map(l => fmtLoc(root, l)).join('\n') : 'No references found.'; break }
      case 'hover': { const r = await lsp.hover(path, pos); out = r?.contents ?? 'No hover information at that position.'; break }
      case 'documentSymbol': { const r = await lsp.documentSymbols(path); out = r.length ? r.flatMap(s => fmtSym(root, s)).join('\n') : 'No symbols found (or no language server for this file).'; break }
      case 'diagnostics': {
        const r = await lsp.diagnostics(path)
        out = r.filter(d => d.severity !== 'hint').length ? r.filter(d => d.severity !== 'hint').map(d => `${displayPath(root, path)}:${d.line}:${d.col} ${d.severity}${d.code ? ` ${d.code}` : ''}: ${d.message.split('\n')[0]}`).join('\n') : 'No problems reported.'
        break
      }
      default: {
        const items = await lsp.callHierarchy(path, pos, 'prepare')
        if (!items.length) { out = 'No call hierarchy item at that position.'; break }
        if (i.operation === 'prepareCallHierarchy') { out = items.map(c => fmtCall(root, c)).join('\n'); break }
        const calls = await lsp.callHierarchy(path, pos, i.operation === 'incomingCalls' ? 'incoming' : 'outgoing', items[0])
        out = calls.length ? `${i.operation === 'incomingCalls' ? 'Callers of' : 'Calls made by'} ${items[0].name}:\n` + calls.map(c => fmtCall(root, c)).join('\n') : 'None found.'
      }
    }
    return { output: (await truncateOutput(out, { save: false })).text, title: i.operation }
  }
})
