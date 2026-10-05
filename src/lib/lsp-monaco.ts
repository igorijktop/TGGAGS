// Bridges the main-process language services (TypeScript worker + external LSP servers) to Monaco providers.
import { monaco } from './monaco'
import { api, onEvent } from './api'
import { ensureModel, pathOfModel, uriFor, uriPath } from './docs'
import { create } from 'zustand'
import type { LspCompletionItem, LspDiagnostic, LspFileEdits, LspLocation, LspRange, LspSymbol } from '@shared/dev'
import { getSettings } from '../stores/settings'
import { formatDocumentText, prettierLanguages } from './prettier'

const K = monaco.languages.CompletionItemKind
const COMPLETION_KIND: Record<string, monaco.languages.CompletionItemKind> = {
  text: K.Text, method: K.Method, function: K.Function, constructor: K.Constructor, field: K.Field, variable: K.Variable, class: K.Class, interface: K.Interface, module: K.Module, property: K.Property, unit: K.Unit,
  value: K.Value, enum: K.Enum, keyword: K.Keyword, snippet: K.Snippet, color: K.Color, file: K.File, reference: K.Reference, folder: K.Folder, enumMember: K.EnumMember, constant: K.Constant, struct: K.Struct,
  event: K.Event, operator: K.Operator, typeParameter: K.TypeParameter, type: K.Class
}
const S = monaco.languages.SymbolKind
const SYMBOL_KIND: Record<string, monaco.languages.SymbolKind> = {
  file: S.File, module: S.Module, namespace: S.Namespace, package: S.Package, class: S.Class, method: S.Method, property: S.Property, field: S.Field, constructor: S.Constructor, enum: S.Enum, interface: S.Interface,
  function: S.Function, variable: S.Variable, constant: S.Constant, string: S.String, number: S.Number, boolean: S.Boolean, array: S.Array, object: S.Object, key: S.Key, null: S.Null, enumMember: S.EnumMember,
  struct: S.Struct, event: S.Event, operator: S.Operator, typeParameter: S.TypeParameter, type: S.Class
}

const toRange = (r: LspRange) => new monaco.Range(r.line, r.col, r.endLine, r.endCol)
const fromRange = (r: monaco.IRange): LspRange => ({ line: r.startLineNumber, col: r.startColumn, endLine: r.endLineNumber, endCol: r.endColumn })

async function toLocations(list: LspLocation[]): Promise<monaco.languages.Location[]> {
  await Promise.all([...new Set(list.map(l => l.path))].slice(0, 40).map(p => ensureModel(p)))
  return list.map(l => ({ uri: uriFor(l.path), range: toRange(l) }))
}

function toSymbols(list: LspSymbol[]): monaco.languages.DocumentSymbol[] {
  return list.map(s => ({
    name: s.name, detail: s.detail ?? '', kind: SYMBOL_KIND[s.kind] ?? S.Variable, tags: [], range: toRange(s), selectionRange: toRange(s), containerName: s.containerName, children: s.children ? toSymbols(s.children) : undefined
  }))
}

async function workspaceEdit(files: LspFileEdits[]): Promise<monaco.languages.WorkspaceEdit> {
  await Promise.all(files.map(f => ensureModel(f.path)))
  const edits: monaco.languages.IWorkspaceTextEdit[] = []
  for (const f of files) for (const e of f.edits) edits.push({ resource: uriFor(f.path), versionId: undefined, textEdit: { range: toRange(e), text: e.newText } })
  return { edits }
}

// ───────────── diagnostics store ─────────────
export interface FileDiagnostics { path: string; diagnostics: LspDiagnostic[] }
export const useDiagnostics = create<{ byPath: Record<string, LspDiagnostic[]>; errors: number; warnings: number }>(() => ({ byPath: {}, errors: 0, warnings: 0 }))

function recount(byPath: Record<string, LspDiagnostic[]>) {
  let errors = 0, warnings = 0
  for (const list of Object.values(byPath)) for (const d of list) { if (d.severity === 'error') errors++; else if (d.severity === 'warning') warnings++ }
  return { byPath, errors, warnings }
}

const SEVERITY: Record<LspDiagnostic['severity'], monaco.MarkerSeverity> = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint }

function applyMarkers(path: string, list: LspDiagnostic[]) {
  const model = monaco.editor.getModel(uriFor(path))
  if (!model) return
  monaco.editor.setModelMarkers(model, 'lsp', list.map(d => ({
    severity: SEVERITY[d.severity], message: d.message, startLineNumber: d.line, startColumn: d.col, endLineNumber: d.endLine, endColumn: d.endCol, code: d.code !== undefined ? String(d.code) : undefined, source: d.source,
    tags: d.unnecessary ? [monaco.MarkerTag.Unnecessary] : d.deprecated ? [monaco.MarkerTag.Deprecated] : undefined
  })))
}

let registered = false
export function registerLspProviders(): void {
  if (registered) return
  registered = true

  onEvent('lsp:diagnostics', ({ path, diagnostics }) => {
    const byPath = { ...useDiagnostics.getState().byPath }
    if (diagnostics.length) byPath[path] = diagnostics; else delete byPath[path]
    useDiagnostics.setState(recount(byPath))
    applyMarkers(path, diagnostics)
  })
  monaco.editor.onDidCreateModel(m => { const p = pathOfModel(m); if (p) { const d = useDiagnostics.getState().byPath[p]; if (d) applyMarkers(p, d) } })

  const langs = ['typescript', 'javascript', 'python', 'go', 'rust', 'c', 'cpp']
  const path = (m: monaco.editor.ITextModel) => pathOfModel(m)
  const pos = (p: monaco.Position) => ({ line: p.lineNumber, col: p.column })

  for (const lang of langs) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', '"', "'", '/', '@', '<', ':', '(', '#'],
      async provideCompletionItems(model, position, context) {
        const p = path(model)
        if (!p) return { suggestions: [] }
        const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined
        const res = await api.lsp.completion(p, pos(position), trigger).catch(() => ({ items: [] as LspCompletionItem[], incomplete: false }))
        const word = model.getWordUntilPosition(position)
        const defRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        return {
          incomplete: res.incomplete,
          suggestions: res.items.map(i => ({
            label: i.label, kind: COMPLETION_KIND[i.kind] ?? K.Text, insertText: i.insertText ?? i.label, range: i.range ? toRange(i.range) : defRange, detail: i.detail, sortText: i.sortText, filterText: i.filterText,
            documentation: i.documentation ? { value: i.documentation } : undefined, commitCharacters: i.commitCharacters, preselect: i.preselect, tags: i.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
            insertTextRules: i.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, _lsp: i
          } as monaco.languages.CompletionItem))
        }
      },
      async resolveCompletionItem(item) {
        const lsp = (item as unknown as { _lsp?: LspCompletionItem })._lsp
        const m = monaco.editor.getModels().find(x => x.uri.scheme === 'file' && uriPath(x.uri) && false)
        void m
        const editor = monaco.editor.getEditors().find(e => e.hasTextFocus()) ?? monaco.editor.getEditors()[0]
        const model = editor?.getModel()
        const p = model ? path(model) : undefined
        if (!lsp || !p || !editor) return item
        const r = await api.lsp.completionResolve(p, pos(editor.getPosition()!), lsp).catch(() => ({}) as { documentation?: string; detail?: string; additionalEdits?: { line: number; col: number; endLine: number; endCol: number; newText: string }[] })
        if (r.documentation) item.documentation = { value: r.documentation }
        if (r.detail) item.detail = r.detail.replace(/```\w*\n?|```/g, '').trim()
        if (r.additionalEdits?.length) item.additionalTextEdits = r.additionalEdits.map(e => ({ range: toRange(e), text: e.newText }))
        return item
      }
    })

    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const p = path(model)
        if (!p) return null
        const h = await api.lsp.hover(p, pos(position)).catch(() => null)
        return h ? { contents: [{ value: h.contents, isTrusted: false }], range: h.range ? toRange(h.range) : undefined } : null
      }
    })
    monaco.languages.registerDefinitionProvider(lang, { async provideDefinition(model, position) { const p = path(model); return p ? toLocations(await api.lsp.definition(p, pos(position)).catch(() => [])) : [] } })
    monaco.languages.registerTypeDefinitionProvider(lang, { async provideTypeDefinition(model, position) { const p = path(model); return p ? toLocations(await api.lsp.typeDefinition(p, pos(position)).catch(() => [])) : [] } })
    monaco.languages.registerImplementationProvider(lang, { async provideImplementation(model, position) { const p = path(model); return p ? toLocations(await api.lsp.implementation(p, pos(position)).catch(() => [])) : [] } })
    monaco.languages.registerReferenceProvider(lang, { async provideReferences(model, position) { const p = path(model); return p ? toLocations(await api.lsp.references(p, pos(position)).catch(() => [])) : [] } })
    monaco.languages.registerDocumentSymbolProvider(lang, { async provideDocumentSymbols(model) { const p = path(model); return p ? toSymbols(await api.lsp.documentSymbols(p).catch(() => [])) : [] } })
    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [')'],
      async provideSignatureHelp(model, position, _t, ctx) {
        const p = path(model)
        if (!p) return null
        const r = await api.lsp.signatureHelp(p, pos(position), ctx.triggerCharacter).catch(() => null)
        if (!r) return null
        return { value: { activeSignature: r.activeSignature, activeParameter: r.activeParameter, signatures: r.signatures.map(s => ({ label: s.label, documentation: s.documentation ? { value: s.documentation } : undefined, parameters: s.parameters.map(pp => ({ label: pp.label, documentation: pp.documentation ? { value: pp.documentation } : undefined })) })) }, dispose() { /* nothing */ } }
      }
    })
    monaco.languages.registerRenameProvider(lang, {
      async resolveRenameLocation(model, position) {
        const p = path(model)
        if (!p) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'No file' }
        try { const r = await api.lsp.prepareRename(p, pos(position)); return r ? { range: toRange(r.range), text: r.text } : { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'This symbol cannot be renamed.' } }
        catch (e) { return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: (e as Error).message } }
      },
      async provideRenameEdits(model, position, newName) { const p = path(model); return p ? workspaceEdit(await api.lsp.rename(p, pos(position), newName)) : { edits: [] } }
    })
    monaco.languages.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, context) {
        const p = path(model)
        if (!p) return { actions: [], dispose() { /* nothing */ } }
        const diags = context.markers.filter(m => m.code !== undefined).map(m => ({ line: m.startLineNumber, col: m.startColumn, endLine: m.endLineNumber, endCol: m.endColumn, severity: 'error' as const, message: m.message, code: typeof m.code === 'object' ? Number(m.code.value) : Number(m.code) }))
        const actions = await api.lsp.codeActions(p, fromRange(range), diags).catch(() => [])
        return {
          actions: await Promise.all(actions.map(async a => ({ title: a.title, kind: a.kind ?? 'quickfix', isPreferred: a.isPreferred, edit: await workspaceEdit(a.edits) }))), dispose() { /* nothing */ }
        }
      }
    }, { providedCodeActionKinds: ['quickfix'] })
  }

  // formatting: Prettier / external formatter first, then the language server
  for (const lang of new Set([...prettierLanguages, 'python', 'go', 'rust', 'c', 'cpp'])) {
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      displayName: 'TGGAGS formatter',
      async provideDocumentFormattingEdits(model, options) {
        const p = path(model)
        if (!p) return []
        try {
          const text = await formatDocumentText(p, model.getValue(), model.getLanguageId())
          if (text !== null) return [{ range: model.getFullModelRange(), text }]
        } catch { /* fall through to the language server */ }
        const edits = await api.lsp.format(p, { tabSize: options.tabSize, insertSpaces: options.insertSpaces }).catch(() => [])
        return edits.map(e => ({ range: toRange(e), text: e.newText }))
      }
    })
  }
  void getSettings
}
