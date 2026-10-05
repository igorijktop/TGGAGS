import { monaco } from '../../lib/monaco'
import { uriPath } from '../../lib/docs'
import { useEditor } from '../../stores/editor'

/** One-time Monaco integrations: open files in tabs on go-to-definition, merge-conflict CodeLens. */
export function initEditorIntegrations(): void {
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const path = uriPath(resource)
      if (!path) return false
      const sel = selectionOrPosition as { startLineNumber?: number; startColumn?: number; lineNumber?: number; column?: number } | undefined
      const line = sel?.startLineNumber ?? sel?.lineNumber
      const col = sel?.startColumn ?? sel?.column
      void useEditor.getState().openFile(path, { line, col, pin: true })
      return true
    }
  })

  // merge conflict resolution lenses
  const cmd = (id: string, mode: 'current' | 'incoming' | 'both') => monaco.editor.registerCommand(id, (_a, uri: string, start: number, mid: number, end: number) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (!model) return
    const lines = model.getLinesContent()
    const cur = lines.slice(start, mid - 1).join('\n'), inc = lines.slice(mid, end - 1).join('\n')
    const text = mode === 'current' ? cur : mode === 'incoming' ? inc : `${cur}\n${inc}`
    model.pushEditOperations([], [{ range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)), text }], () => null)
  })
  cmd('tgg.conflict.current', 'current'); cmd('tgg.conflict.incoming', 'incoming'); cmd('tgg.conflict.both', 'both')
  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      const lenses: monaco.languages.CodeLens[] = []
      const n = model.getLineCount()
      if (n > 20000) return { lenses, dispose() { /* none */ } }
      let start = 0, mid = 0
      for (let i = 1; i <= n; i++) {
        const l = model.getLineContent(i)
        if (l.startsWith('<<<<<<< ')) { start = i; mid = 0 }
        else if (l.startsWith('=======') && start) mid = i
        else if (l.startsWith('>>>>>>> ') && start && mid) {
          const args = [model.uri.toString(), start, mid, i]
          const range = new monaco.Range(start, 1, start, 1)
          lenses.push({ range, command: { id: 'tgg.conflict.current', title: 'Accept Current Change', arguments: args } }, { range, command: { id: 'tgg.conflict.incoming', title: 'Accept Incoming Change', arguments: args } }, { range, command: { id: 'tgg.conflict.both', title: 'Accept Both Changes', arguments: args } })
          start = mid = 0
        }
      }
      return { lenses, dispose() { /* none */ } }
    }
  })
}
