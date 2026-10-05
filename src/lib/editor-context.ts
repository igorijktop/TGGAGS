import { monaco } from './monaco'
import { api } from './api'
import { pathOfModel } from './docs'
import { useEditor } from '../stores/editor'
import { useDiagnostics } from './lsp-monaco'
import type { EditorContext } from '@shared/ai'

export function activeMonacoEditor(): monaco.editor.IStandaloneCodeEditor | null {
  const eds = monaco.editor.getEditors()
  return (eds.find(e => e.hasTextFocus()) ?? eds.find(e => e.getContainerDomNode().offsetParent !== null) ?? null) as monaco.editor.IStandaloneCodeEditor | null
}

/** What the agent can see of the editor: active file, selection, open tabs, problems and terminal tail. */
export async function gatherEditorContext(): Promise<EditorContext> {
  const st = useEditor.getState()
  const tabs = Object.values(st.groups).flatMap(g => g.tabs.filter(t => t.kind === 'file' && t.path).map(t => t.path!))
  const active = st.activeTab()
  const ctx: EditorContext = { openTabs: [...new Set(tabs)] }
  if (active?.kind === 'file' && active.path) {
    ctx.activeFile = active.path
    const ed = activeMonacoEditor()
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    if (ed && model && sel && !sel.isEmpty() && pathOfModel(model) === active.path) {
      ctx.selection = { path: active.path, startLine: sel.startLineNumber, endLine: sel.endLineNumber, text: model.getValueInRange(sel).slice(0, 20_000) }
    }
  }
  const diags = useDiagnostics.getState().byPath
  const list: NonNullable<EditorContext['diagnostics']> = []
  for (const p of tabs) for (const d of diags[p] ?? []) if (d.severity === 'error' || d.severity === 'warning') list.push({ path: p, line: d.line, severity: d.severity, message: d.message.split('\n')[0] })
  if (list.length) ctx.diagnostics = list.slice(0, 80)
  try { ctx.terminalTail = await api.terminal.tail(6000) } catch { /* no terminal */ }
  return ctx
}
