// Document manager: one Monaco model per open file, dirty tracking, saving, external-change handling and language-server sync.
import { create } from 'zustand'
import { monaco } from './monaco'
import { api, onEvent } from './api'
import { debounce, basename } from './util'
import { languageForPath } from '@shared/languages'
import { getSettings } from '../stores/settings'
import { formatDocumentText } from './prettier'

export interface Doc {
  path: string
  model: monaco.editor.ITextModel
  encoding: string
  savedVersion: number
  mtime: number
  opened: boolean
}

interface DocsState {
  dirty: Record<string, boolean>
  external: Record<string, 'changed' | 'deleted'>
  saving: Record<string, boolean>
}
export const useDocs = create<DocsState>(() => ({ dirty: {}, external: {}, saving: {} }))

const docs = new Map<string, Doc>()
const uriToPath = new Map<string, string>()
const lspOpen = new Set<string>()
const pending = new Map<string, Promise<Doc | null>>()
const autoSave = new Map<string, ReturnType<typeof debounce>>()

export const pathOfModel = (m: monaco.editor.ITextModel): string | undefined => uriPath(m.uri)
export const uriPath = (u: monaco.Uri): string | undefined => uriToPath.get(u.toString())
export const uriFor = (path: string) => monaco.Uri.file(path)
export const getDoc = (path: string): Doc | undefined => docs.get(path)
export const allDocs = (): Doc[] => [...docs.values()]
export const dirtyPaths = (): string[] => Object.keys(useDocs.getState().dirty).filter(p => useDocs.getState().dirty[p])

const lspLanguages = () => {
  const s = getSettings().lsp
  if (!s.enabled) return new Set<string>()
  const set = new Set<string>(s.typescript ? ['typescript', 'javascript'] : [])
  for (const c of Object.values(s.servers)) if (c.enabled) c.languages.forEach(l => set.add(l))
  return set
}

function setDirty(path: string, dirty: boolean) {
  const cur = useDocs.getState().dirty
  if (!!cur[path] === dirty) return
  useDocs.setState({ dirty: { ...cur, [path]: dirty } })
}

function wire(doc: Doc) {
  const { model, path } = doc
  const lang = model.getLanguageId()
  const syncLsp = debounce(() => { void api.lsp.change(path, model.getValue(), model.getVersionId()).catch(() => undefined) }, 140)
  if (lspLanguages().has(lang)) { lspOpen.add(path); void api.lsp.open(path, model.getValue(), lang, model.getVersionId()).catch(() => undefined) }
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== doc.savedVersion
    setDirty(path, dirty)
    if (lspOpen.has(path)) syncLsp()
    if (dirty && doc.opened && getSettings().editor.autoSave === 'afterDelay') {
      let d = autoSave.get(path)
      if (!d) { d = debounce(() => { void saveDoc(path).catch(() => undefined) }, getSettings().editor.autoSaveDelay); autoSave.set(path, d) }
      d()
    }
  })
  model.onWillDispose(() => { if (lspOpen.delete(path)) void api.lsp.close(path).catch(() => undefined); docs.delete(path); autoSave.get(path)?.cancel(); autoSave.delete(path); uriToPath.delete(model.uri.toString()) })
}

export type OpenResult = { kind: 'text'; doc: Doc } | { kind: 'binary' | 'tooLarge'; size: number; mime?: string; path: string }

export async function openDoc(path: string, opened = true): Promise<OpenResult> {
  const existing = docs.get(path)
  if (existing) { if (opened) existing.opened = true; return { kind: 'text', doc: existing } }
  const r = await api.fs.readFile(path)
  if (r.kind !== 'text') return { kind: r.kind, size: r.size, mime: r.kind === 'binary' ? r.mime : undefined, path }
  const race = docs.get(path)
  if (race) return { kind: 'text', doc: race }
  const uri = uriFor(path)
  uriToPath.set(uri.toString(), path)
  monaco.editor.getModel(uri)?.dispose()
  const model = monaco.editor.createModel(r.content, languageForPath(path), uri)
  if (r.eol === 'crlf') model.setEOL(monaco.editor.EndOfLineSequence.CRLF)
  const doc: Doc = { path, model, encoding: r.encoding, savedVersion: model.getAlternativeVersionId(), mtime: r.mtime, opened }
  docs.set(path, doc)
  wire(doc)
  return { kind: 'text', doc }
}

/** Create a (hidden) model so Monaco can peek / apply edits in files that are not open in a tab. */
export async function ensureModel(path: string): Promise<Doc | null> {
  const d = docs.get(path)
  if (d) return d
  let p = pending.get(path)
  if (!p) { p = openDoc(path, false).then(r => (r.kind === 'text' ? r.doc : null)).catch(() => null).finally(() => pending.delete(path)); pending.set(path, p) }
  return p
}

export function closeDoc(path: string): void {
  const d = docs.get(path)
  if (!d) return
  d.model.dispose()
  const dirty = { ...useDocs.getState().dirty }; delete dirty[path]
  const ext = { ...useDocs.getState().external }; delete ext[path]
  useDocs.setState({ dirty, external: ext })
}

export async function saveDoc(path: string): Promise<boolean> {
  const doc = docs.get(path)
  if (!doc) return false
  autoSave.get(path)?.cancel()
  const model = doc.model
  if (getSettings().editor.formatOnSave && doc.opened) {
    try {
      const formatted = await formatDocumentText(path, model.getValue(), model.getLanguageId())
      if (formatted !== null && formatted !== model.getValue()) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: formatted }], () => null)
    } catch { /* formatting is best effort */ }
  }
  const text = model.getValue(monaco.editor.EndOfLinePreference.TextDefined)
  const savedAlt = model.getAlternativeVersionId()
  useDocs.setState(s => ({ saving: { ...s.saving, [path]: true } }))
  try {
    const res = await api.fs.writeFile(path, text, doc.encoding)
    doc.mtime = res.mtime
    doc.savedVersion = savedAlt
    setDirty(path, model.getAlternativeVersionId() !== savedAlt)
    const ext = { ...useDocs.getState().external }; delete ext[path]
    useDocs.setState({ external: ext })
    return true
  } finally { useDocs.setState(s => { const saving = { ...s.saving }; delete saving[path]; return { saving } }) }
}

export async function saveAll(): Promise<number> {
  let n = 0
  for (const p of dirtyPaths()) { try { if (await saveDoc(p)) n++ } catch { /* reported by caller */ } }
  return n
}

export async function reloadDoc(path: string): Promise<void> {
  const doc = docs.get(path)
  if (!doc) return
  const r = await api.fs.readFile(path)
  if (r.kind !== 'text') return
  doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.content }], () => null)
  doc.model.pushStackElement()
  doc.savedVersion = doc.model.getAlternativeVersionId()
  doc.mtime = r.mtime
  setDirty(path, false)
  const ext = { ...useDocs.getState().external }; delete ext[path]
  useDocs.setState({ external: ext })
}

export function keepLocal(path: string): void {
  const ext = { ...useDocs.getState().external }; delete ext[path]
  useDocs.setState({ external: ext })
  const d = docs.get(path)
  if (d) d.mtime = Date.now() + 1000
}

export function renameDoc(from: string, to: string): void {
  // simplest correct behaviour: drop the old model; the caller reopens the new path
  closeDoc(from)
  void to
}

let started = false
export function startDocWatchers(): void {
  if (started) return
  started = true
  onEvent('fs:changed', async ev => {
    for (const c of ev.events) {
      const doc = docs.get(c.path)
      if (!doc) continue
      if (c.type === 'unlink') { useDocs.setState(s => ({ external: { ...s.external, [c.path]: 'deleted' } })); continue }
      if (c.type !== 'change' && c.type !== 'add') continue
      try {
        const st = await api.fs.stat(c.path)
        if (!st.exists || st.mtime <= doc.mtime + 1) continue
        if (useDocs.getState().dirty[c.path]) useDocs.setState(s => ({ external: { ...s.external, [c.path]: 'changed' } }))
        else await reloadDoc(c.path)
      } catch { /* ignore */ }
    }
  })
  window.addEventListener('blur', () => { if (getSettings().editor.autoSave === 'onFocusChange') void saveAll() })
  onEvent('settings:changed', s => {
    // start syncing languages that became available (e.g. after enabling a language server)
    const langs = lspLanguages()
    for (const doc of docs.values()) if (!lspOpen.has(doc.path) && langs.has(doc.model.getLanguageId())) { lspOpen.add(doc.path); void api.lsp.open(doc.path, doc.model.getValue(), doc.model.getLanguageId(), doc.model.getVersionId()).catch(() => undefined) }
    void s
  })
}

export const docTitle = (path: string) => basename(path)
