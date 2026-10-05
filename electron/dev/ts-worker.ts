// TypeScript / JavaScript language service running in a worker thread.
// Positions exchanged with the main process are 1-based { line, col }; this file converts to offsets.
import * as ts from 'typescript'
import { parentPort } from 'node:worker_threads'
import { dirname, resolve as resolvePath } from 'node:path'
import type { LspCallItem, LspCodeAction, LspCompletionItem, LspDiagnostic, LspFileEdits, LspLocation, LspPos, LspRange, LspSignatureHelp, LspSymbol, LspTextEdit } from '../../shared/dev'

const win = process.platform === 'win32'
const norm = (p: string) => p.replace(/\\/g, '/')
const nat = (p: string) => (win ? p.replace(/\//g, '\\') : p)

interface Overlay { text: string; version: number }
const overlays = new Map<string, Overlay>()
let workspaceRoot = ''

interface Project { key: string; configPath?: string; options: ts.CompilerOptions; fileNames: string[]; dirty: boolean; ls: ts.LanguageService; root: string }
const projects = new Map<string, Project>()
const diskVersions = new Map<string, { v: string; at: number }>()
const snapshotCache = new Map<string, { v: string; snap: ts.IScriptSnapshot }>()

const INFERRED: ts.CompilerOptions = {
  allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, allowSyntheticDefaultImports: true, strict: false
}

function diskVersion(f: string): string {
  const c = diskVersions.get(f)
  const now = Date.now()
  if (c && now - c.at < 1500) return c.v
  let v = '0'
  try { v = String(ts.sys.getModifiedTime?.(f)?.getTime() ?? 0) } catch { /* missing */ }
  diskVersions.set(f, { v, at: now })
  return v
}

function readSnapshot(f: string): ts.IScriptSnapshot | undefined {
  const o = overlays.get(f)
  if (o) return ts.ScriptSnapshot.fromString(o.text)
  const v = diskVersion(f)
  const c = snapshotCache.get(f)
  if (c && c.v === v) return c.snap
  const text = ts.sys.readFile(f)
  if (text === undefined) return undefined
  const snap = ts.ScriptSnapshot.fromString(text)
  snapshotCache.set(f, { v, snap })
  return snap
}

function parseConfig(configPath: string): { options: ts.CompilerOptions; fileNames: string[]; references: string[] } {
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, dirname(configPath), undefined, configPath)
  const isJs = /jsconfig\.json$/i.test(configPath)
  return {
    options: { ...parsed.options, noEmit: true, allowJs: parsed.options.allowJs ?? (isJs || true), skipLibCheck: parsed.options.skipLibCheck ?? true },
    fileNames: parsed.fileNames.map(norm),
    references: (parsed.projectReferences ?? []).map(r => ts.resolveProjectReferencePath(r))
  }
}

function makeProject(key: string, configPath: string | undefined, options: ts.CompilerOptions, fileNames: string[], root: string): Project {
  const proj: Project = { key, configPath, options, fileNames, dirty: false, root } as Project
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => {
      if (proj.dirty && proj.configPath) { try { proj.fileNames = parseConfig(proj.configPath).fileNames } catch { /* keep old */ } proj.dirty = false }
      const open = [...overlays.keys()].filter(f => projectKeyFor(f) === proj.key)
      return [...new Set([...proj.fileNames, ...open])]
    },
    getScriptVersion: f => { const o = overlays.get(f); return o ? `o${o.version}` : diskVersion(f) },
    getScriptSnapshot: readSnapshot,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => proj.options,
    getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
    fileExists: f => overlays.has(f) || ts.sys.fileExists(f),
    readFile: f => overlays.get(f)?.text ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
  }
  proj.ls = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root))
  projects.set(key, proj)
  return proj
}

function configFor(file: string): string | undefined {
  const dir = dirname(file)
  return ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json')
}

function projectKeyFor(file: string): string {
  let cfg = configFor(file)
  if (cfg) {
    const existing = projects.get(cfg)
    if (existing) { if (existing.fileNames.includes(file) || !referencesOnly(existing)) return cfg }
    else {
      try {
        const p = parseConfig(cfg)
        if (!p.fileNames.length && p.references.length) {
          for (const r of p.references) { try { const sub = parseConfig(r); if (sub.fileNames.includes(file)) { cfg = r; break } } catch { /* skip */ } }
        }
      } catch { /* fall through */ }
      return cfg
    }
  }
  return cfg ?? `inferred:${workspaceRoot || dirname(file)}`
}

function referencesOnly(p: Project): boolean { return p.fileNames.length === 0 }

function getProject(file: string): Project {
  const key = projectKeyFor(file)
  const existing = projects.get(key)
  if (existing) return existing
  if (key.startsWith('inferred:')) return makeProject(key, undefined, INFERRED, [], key.slice(9))
  const p = parseConfig(key)
  return makeProject(key, key, p.options, p.fileNames, dirname(key))
}

// ───────────── conversions ─────────────
const FORMAT: ts.FormatCodeSettings = { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true, insertSpaceBeforeAndAfterBinaryOperators: true, semicolons: ts.SemicolonPreference.Ignore }
const PREFS: ts.UserPreferences = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true, includeAutomaticOptionalChainCompletions: true, includePackageJsonAutoImports: 'auto', providePrefixAndSuffixTextForRename: true, allowRenameOfImportPath: false }

function sourceFile(p: Project, file: string): ts.SourceFile | undefined { return p.ls.getProgram()?.getSourceFile(file) }

function offsetOf(sf: ts.SourceFile, pos: LspPos): number {
  const line = Math.min(Math.max(pos.line - 1, 0), sf.getLineStarts().length - 1)
  return ts.getPositionOfLineAndCharacter(sf, line, Math.max(pos.col - 1, 0))
}

function rangeOf(sf: ts.SourceFile, start: number, length: number): LspRange {
  const a = sf.getLineAndCharacterOfPosition(start)
  const b = sf.getLineAndCharacterOfPosition(start + length)
  return { line: a.line + 1, col: a.character + 1, endLine: b.line + 1, endCol: b.character + 1 }
}

function locOf(p: Project, file: string, span: ts.TextSpan): LspLocation | null {
  const sf = sourceFile(p, file)
  if (!sf) return null
  const r = rangeOf(sf, span.start, span.length)
  const text = sf.text.split('\n')[r.line - 1]?.trim().slice(0, 200)
  return { path: nat(file), ...r, preview: text }
}

function prepare(file: string): { p: Project; sf: ts.SourceFile } {
  const f = norm(file)
  const p = getProject(f)
  p.ls.getProgram() // ensure fresh
  const sf = sourceFile(p, f)
  if (!sf) throw new Error(`File is not part of a TypeScript/JavaScript project: ${file}`)
  return { p, sf }
}

const KIND_MAP: Record<string, string> = {
  function: 'function', 'local function': 'function', method: 'method', 'construct': 'class', 'constructor': 'class', class: 'class', 'local class': 'class', interface: 'interface', module: 'module',
  'external module name': 'module', 'primitive type': 'keyword', keyword: 'keyword', var: 'variable', 'local var': 'variable', let: 'variable', parameter: 'variable', property: 'property', getter: 'property',
  setter: 'property', 'JSX attribute': 'property', const: 'constant', 'enum': 'enum', 'enum member': 'enumMember', type: 'type', 'type parameter': 'typeParameter', alias: 'variable', directory: 'folder',
  script: 'file', 'string': 'text', 'warning': 'text', 'index': 'property', 'call': 'function', 'member': 'property'
}
const kindName = (k: string) => KIND_MAP[k] ?? 'variable'

function mdFromParts(parts?: ts.SymbolDisplayPart[]): string { return ts.displayPartsToString(parts) }

function tagsToMd(tags?: ts.JSDocTagInfo[]): string {
  if (!tags?.length) return ''
  return tags.map(t => {
    const text = ts.displayPartsToString(t.text)
    return text ? `*@${t.name}* — ${text}` : `*@${t.name}*`
  }).join('\n\n')
}

function sev(c: ts.DiagnosticCategory): LspDiagnostic['severity'] {
  return c === ts.DiagnosticCategory.Error ? 'error' : c === ts.DiagnosticCategory.Warning ? 'warning' : c === ts.DiagnosticCategory.Suggestion ? 'hint' : 'info'
}

function toDiag(sf: ts.SourceFile, d: ts.Diagnostic): LspDiagnostic | null {
  if (d.start === undefined) return null
  const r = rangeOf(sf, d.start, d.length ?? 1)
  return { ...r, severity: sev(d.category), message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), code: d.code, source: 'ts', unnecessary: !!d.reportsUnnecessary, deprecated: !!d.reportsDeprecated }
}

function editsFromChanges(p: Project, changes: readonly ts.FileTextChanges[]): LspFileEdits[] {
  const out: LspFileEdits[] = []
  for (const fc of changes) {
    const sf = sourceFile(p, norm(fc.fileName)) ?? (() => { const t = ts.sys.readFile(fc.fileName); return t === undefined ? undefined : ts.createSourceFile(fc.fileName, t, ts.ScriptTarget.Latest) })()
    if (!sf) continue
    out.push({ path: nat(norm(fc.fileName)), edits: fc.textChanges.map(tc => ({ ...rangeOf(sf, tc.span.start, tc.span.length), newText: tc.newText })) })
  }
  return out
}

function symbolFromTree(sf: ts.SourceFile, n: ts.NavigationTree, container?: string): LspSymbol | null {
  const span = n.spans[0]
  if (!span) return null
  const r = rangeOf(sf, span.start, span.length)
  const children = (n.childItems ?? []).map(c => symbolFromTree(sf, c, n.text)).filter((x): x is LspSymbol => !!x)
  return { name: n.text, kind: kindName(n.kind), ...r, containerName: container, children: children.length ? children : undefined }
}

function callItem(p: Project, it: ts.CallHierarchyItem): LspCallItem {
  const file = norm(it.file)
  const sf = sourceFile(p, file)
  const range = sf ? rangeOf(sf, it.span.start, it.span.length) : { line: 1, col: 1, endLine: 1, endCol: 1 }
  const selection = sf ? rangeOf(sf, it.selectionSpan.start, it.selectionSpan.length) : range
  return { name: it.name, kind: kindName(it.kind), path: nat(file), detail: it.containerName, range, selection, data: { offset: it.selectionSpan.start } }
}

// ───────────── handlers ─────────────
type P = Record<string, unknown>
const handlers: Record<string, (a: P) => unknown> = {
  setRoot: a => { workspaceRoot = norm(String(a.root)); for (const pr of projects.values()) pr.ls.dispose(); projects.clear(); overlays.clear() },
  open: a => { const f = norm(String(a.path)); overlays.set(f, { text: String(a.text), version: Number(a.version) }); return true },
  change: a => { const f = norm(String(a.path)); const o = overlays.get(f); overlays.set(f, { text: String(a.text), version: Number(a.version) || (o?.version ?? 0) + 1 }); return true },
  close: a => { const f = norm(String(a.path)); overlays.delete(f); diskVersions.delete(f); return true },
  invalidate: () => { diskVersions.clear(); snapshotCache.clear(); for (const p of projects.values()) p.dirty = true; return true },

  diagnostics: a => {
    const { p, sf } = prepare(String(a.path))
    const f = sf.fileName
    const all = [...p.ls.getSyntacticDiagnostics(f), ...p.ls.getSemanticDiagnostics(f), ...p.ls.getSuggestionDiagnostics(f)]
    return all.map(d => toDiag(sf, d)).filter((d): d is LspDiagnostic => !!d)
  },

  definition: a => {
    const { p, sf } = prepare(String(a.path))
    const defs = p.ls.getDefinitionAtPosition(sf.fileName, offsetOf(sf, a.pos as LspPos)) ?? []
    return defs.map(d => locOf(p, norm(d.fileName), d.textSpan)).filter(Boolean)
  },
  typeDefinition: a => {
    const { p, sf } = prepare(String(a.path))
    const defs = p.ls.getTypeDefinitionAtPosition(sf.fileName, offsetOf(sf, a.pos as LspPos)) ?? []
    return defs.map(d => locOf(p, norm(d.fileName), d.textSpan)).filter(Boolean)
  },
  implementation: a => {
    const { p, sf } = prepare(String(a.path))
    const defs = p.ls.getImplementationAtPosition(sf.fileName, offsetOf(sf, a.pos as LspPos)) ?? []
    return defs.map(d => locOf(p, norm(d.fileName), d.textSpan)).filter(Boolean)
  },
  references: a => {
    const { p, sf } = prepare(String(a.path))
    const refs = p.ls.getReferencesAtPosition(sf.fileName, offsetOf(sf, a.pos as LspPos)) ?? []
    return refs.map(r => locOf(p, norm(r.fileName), r.textSpan)).filter(Boolean)
  },

  hover: a => {
    const { p, sf } = prepare(String(a.path))
    const info = p.ls.getQuickInfoAtPosition(sf.fileName, offsetOf(sf, a.pos as LspPos))
    if (!info) return null
    const sig = mdFromParts(info.displayParts)
    const doc = mdFromParts(info.documentation)
    const tags = tagsToMd(info.tags)
    return { contents: ['```typescript\n' + sig + '\n```', doc, tags].filter(Boolean).join('\n\n'), range: rangeOf(sf, info.textSpan.start, info.textSpan.length) }
  },

  completion: a => {
    const { p, sf } = prepare(String(a.path))
    const offset = offsetOf(sf, a.pos as LspPos)
    const res = p.ls.getCompletionsAtPosition(sf.fileName, offset, { ...PREFS, triggerCharacter: (a.trigger as ts.CompletionsTriggerCharacter | undefined) }, FORMAT)
    if (!res) return { items: [], incomplete: false }
    const wordRange = res.optionalReplacementSpan
    const items: LspCompletionItem[] = res.entries.map(e => {
      const span = e.replacementSpan ?? wordRange
      return {
        label: e.name, kind: kindName(e.kind), sortText: e.sortText, insertText: e.insertText ?? e.name, filterText: e.filterText,
        range: span ? rangeOf(sf, span.start, span.length) : undefined, detail: e.source ? `Auto-import from ${e.source}` : e.kindModifiers || undefined,
        deprecated: !!e.kindModifiers?.includes('deprecated'), commitCharacters: e.commitCharacters, preselect: e.isRecommended,
        data: { name: e.name, source: e.source, hasAction: e.hasAction, tsData: e.data }
      }
    })
    return { items, incomplete: !!res.isIncomplete }
  },
  completionResolve: a => {
    const { p, sf } = prepare(String(a.path))
    const item = a.item as LspCompletionItem
    const d = item.data as { name: string; source?: string; tsData?: ts.CompletionEntryData } | undefined
    if (!d) return {}
    const det = p.ls.getCompletionEntryDetails(sf.fileName, offsetOf(sf, a.pos as LspPos), d.name, FORMAT, d.source, PREFS, d.tsData)
    if (!det) return {}
    const additionalEdits: LspTextEdit[] = []
    for (const ca of det.codeActions ?? []) for (const ch of ca.changes) if (norm(ch.fileName) === sf.fileName) for (const tc of ch.textChanges) additionalEdits.push({ ...rangeOf(sf, tc.span.start, tc.span.length), newText: tc.newText })
    const doc = [mdFromParts(det.documentation), tagsToMd(det.tags)].filter(Boolean).join('\n\n')
    return { documentation: doc || undefined, detail: '```typescript\n' + mdFromParts(det.displayParts) + '\n```', additionalEdits }
  },

  signatureHelp: a => {
    const { p, sf } = prepare(String(a.path))
    const res = p.ls.getSignatureHelpItems(sf.fileName, offsetOf(sf, a.pos as LspPos), a.trigger ? { triggerReason: { kind: 'characterTyped', triggerCharacter: a.trigger as ts.SignatureHelpTriggerCharacter } } : undefined)
    if (!res) return null
    const out: LspSignatureHelp = {
      activeSignature: res.selectedItemIndex, activeParameter: res.argumentIndex,
      signatures: res.items.map(it => {
        const params = it.parameters.map(pm => ({ label: mdFromParts(pm.displayParts), documentation: mdFromParts(pm.documentation) || undefined }))
        const label = mdFromParts(it.prefixDisplayParts) + params.map(pm => pm.label).join(mdFromParts(it.separatorDisplayParts)) + mdFromParts(it.suffixDisplayParts)
        return { label, documentation: [mdFromParts(it.documentation), tagsToMd(it.tags)].filter(Boolean).join('\n\n') || undefined, parameters: params }
      })
    }
    return out
  },

  prepareRename: a => {
    const { p, sf } = prepare(String(a.path))
    const info = p.ls.getRenameInfo(sf.fileName, offsetOf(sf, a.pos as LspPos), { allowRenameOfImportPath: false })
    if (!info.canRename) throw new Error(info.localizedErrorMessage || 'This symbol cannot be renamed.')
    return { range: rangeOf(sf, info.triggerSpan.start, info.triggerSpan.length), text: info.displayName }
  },
  rename: a => {
    const { p, sf } = prepare(String(a.path))
    const locs = p.ls.findRenameLocations(sf.fileName, offsetOf(sf, a.pos as LspPos), false, false, PREFS) ?? []
    const byFile = new Map<string, LspTextEdit[]>()
    for (const l of locs) {
      const f = norm(l.fileName)
      const s = sourceFile(p, f)
      if (!s) continue
      const arr = byFile.get(f) ?? []
      arr.push({ ...rangeOf(s, l.textSpan.start, l.textSpan.length), newText: `${l.prefixText ?? ''}${a.newName}${l.suffixText ?? ''}` })
      byFile.set(f, arr)
    }
    return [...byFile].map(([f, edits]) => ({ path: nat(f), edits }))
  },

  documentSymbols: a => {
    const { p, sf } = prepare(String(a.path))
    const tree = p.ls.getNavigationTree(sf.fileName)
    return (tree.childItems ?? []).map(c => symbolFromTree(sf, c)).filter(Boolean)
  },
  workspaceSymbols: a => {
    const anyFile = [...overlays.keys()][0]
    const p = anyFile ? getProject(anyFile) : [...projects.values()][0]
    if (!p) return []
    p.ls.getProgram()
    const items = p.ls.getNavigateToItems(String(a.query), 60) ?? []
    return items.map(i => {
      const sf = sourceFile(p, norm(i.fileName))
      if (!sf) return null
      return { name: i.name, kind: kindName(i.kind), ...rangeOf(sf, i.textSpan.start, i.textSpan.length), containerName: i.containerName || undefined, path: nat(norm(i.fileName)) } as LspSymbol
    }).filter(Boolean)
  },

  codeActions: a => {
    const { p, sf } = prepare(String(a.path))
    const r = a.range as LspRange
    const start = offsetOf(sf, { line: r.line, col: r.col }), end = offsetOf(sf, { line: r.endLine, col: r.endCol })
    const codes = ((a.diagnostics as LspDiagnostic[]) ?? []).map(d => Number(d.code)).filter(n => Number.isFinite(n))
    const out: LspCodeAction[] = []
    if (codes.length) {
      for (const fix of p.ls.getCodeFixesAtPosition(sf.fileName, start, end, [...new Set(codes)], FORMAT, PREFS)) {
        out.push({ title: fix.description, kind: 'quickfix', edits: editsFromChanges(p, fix.changes), isPreferred: fix.fixName === 'import' ? false : undefined })
      }
    }
    return out
  },
  organizeImports: a => {
    const { p, sf } = prepare(String(a.path))
    return editsFromChanges(p, p.ls.organizeImports({ type: 'file', fileName: sf.fileName }, FORMAT, PREFS))
  },
  format: a => {
    const { p, sf } = prepare(String(a.path))
    const o = a.opts as { tabSize: number; insertSpaces: boolean }
    return p.ls.getFormattingEditsForDocument(sf.fileName, { ...FORMAT, tabSize: o.tabSize, indentSize: o.tabSize, convertTabsToSpaces: o.insertSpaces }).map(e => ({ ...rangeOf(sf, e.span.start, e.span.length), newText: e.newText }))
  },

  callHierarchy: a => {
    const { p, sf } = prepare(String(a.path))
    const dir = String(a.direction)
    if (dir === 'prepare') {
      const r = p.ls.prepareCallHierarchy(sf.fileName, offsetOf(sf, a.pos as LspPos))
      return (Array.isArray(r) ? r : r ? [r] : []).map(i => callItem(p, i))
    }
    const item = a.item as LspCallItem
    const f = norm(item.path)
    const psf = prepare(f)
    const off = (item.data as { offset: number }).offset
    if (dir === 'incoming') return psf.p.ls.provideCallHierarchyIncomingCalls(psf.sf.fileName, off).map(c => callItem(psf.p, c.from))
    return psf.p.ls.provideCallHierarchyOutgoingCalls(psf.sf.fileName, off).map(c => callItem(psf.p, c.to))
  }
}

parentPort!.on('message', (msg: { id: number; method: string; params: P }) => {
  try {
    const h = handlers[msg.method]
    if (!h) throw new Error(`unknown method ${msg.method}`)
    const result = h(msg.params ?? {})
    parentPort!.postMessage({ id: msg.id, result: result ?? null })
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message })
  }
})
void resolvePath
