import { useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { monaco } from '../../lib/monaco'
import { api } from '../../lib/api'
import { openDoc, getDoc, pathOfModel, useDocs, reloadDoc, keepLocal, saveDoc } from '../../lib/docs'
import { useSettings } from '../../stores/settings'
import { useEditor, type Tab } from '../../stores/editor'
import { useDebug } from '../../stores/debug'
import { useGit } from '../../stores/git'
import { debounce } from '../../lib/util'
import { runCommand } from '../../lib/commands'
import { Button } from '../../components/ui'
import { toast } from '../../stores/ui'

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
const gitBase = new Map<string, { text: string | null; at: number }>()

async function headContent(path: string): Promise<string | null> {
  const c = gitBase.get(path)
  if (c && Date.now() - c.at < 20_000) return c.text
  let text: string | null = null
  try { const st = useGit.getState().status; if (st?.isRepo) { const s = await api.git.diffSides(path, 'staged'); text = s.binary ? null : s.original } } catch { text = null }
  gitBase.set(path, { text, at: Date.now() })
  return text
}
export const invalidateGitBase = () => gitBase.clear()

export function CodeEditor({ groupId, tab, focused }: { groupId: string; tab: Tab; focused: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const bpRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const lastReveal = useRef(0)
  const [ready, setReady] = useState<string | null>(null)
  const ed = useSettings(s => s.settings.editor)
  const external = useDocs(s => (tab.path ? s.external[tab.path] : undefined))
  const path = tab.path!

  // create the editor once per mount
  useEffect(() => {
    const editor = monaco.editor.create(host.current!, { model: null, automaticLayout: true, glyphMargin: true, lineDecorationsWidth: 12, scrollBeyondLastLine: false, padding: { top: 10, bottom: 40 }, fixedOverflowWidgets: true,
      renderLineHighlight: 'line', cursorSmoothCaretAnimation: 'on', mouseWheelZoom: false, 'semanticHighlighting.enabled': false, quickSuggestionsDelay: 30, suggest: { preview: true, showStatusBar: false }, hover: { delay: 300 }, accessibilitySupport: 'off', contextmenu: true, links: true, occurrencesHighlight: 'singleFile', renderControlCharacters: false, guides: { bracketPairs: 'active', indentation: true }, scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false } })
    edRef.current = editor
    decoRef.current = editor.createDecorationsCollection()
    bpRef.current = editor.createDecorationsCollection()
    const d: monaco.IDisposable[] = []
    d.push(editor.onDidFocusEditorWidget(() => useEditor.getState().focusGroup(groupId)))
    d.push(editor.onDidChangeCursorSelection(() => {
      const model = editor.getModel(); const pos = editor.getPosition(); const sel = editor.getSelection()
      if (!model || !pos || !sel) return
      useEditor.getState().setStatus({ path: pathOfModel(model) ?? null, line: pos.lineNumber, col: pos.column, selected: model.getValueInRange(sel).length, selLines: sel.isEmpty() ? 0 : sel.endLineNumber - sel.startLineNumber + 1, language: model.getLanguageId(), eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF', tabSize: model.getOptions().tabSize, insertSpaces: model.getOptions().insertSpaces })
    }))
    d.push(editor.onMouseDown(e => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) { const p = pathOfModel(editor.getModel()!); if (p) void useDebug.getState().toggleBreakpoint(p, e.target.position.lineNumber) }
    }))
    // AI actions in the context menu
    const aiAction = (id: string, label: string, cmd: string, order: number, needsSelection = false) => editor.addAction({ id, label, contextMenuGroupId: '9_tgg_ai', contextMenuOrder: order, precondition: needsSelection ? 'editorHasSelection' : undefined, run: () => { void runCommand(cmd) } })
    aiAction('tgg.ai.addSelection', 'Add selection to AI chat', 'ai.addSelection', 1, true)
    aiAction('tgg.ai.explain', 'AI: Explain this code', 'ai.explain', 2, true)
    aiAction('tgg.ai.refactor', 'AI: Refactor / improve…', 'ai.refactor', 3, true)
    aiAction('tgg.ai.tests', 'AI: Write tests for this', 'ai.tests', 4, true)
    aiAction('tgg.ai.docs', 'AI: Add documentation comments', 'ai.docsComment', 5, true)
    aiAction('tgg.ai.fix', 'AI: Fix problems in this file', 'ai.fix', 6)
    return () => { const m = editor.getModel(); const p = m && pathOfModel(m); if (p) viewStates.set(`${groupId}|${p}`, editor.saveViewState()); d.forEach(x => x.dispose()); editor.dispose(); edRef.current = null }
  }, [groupId])

  // switch model when the tab changes
  useEffect(() => {
    let cancelled = false
    const editor = edRef.current
    if (!editor) return
    const prev = editor.getModel(); const prevPath = prev && pathOfModel(prev)
    if (prevPath) viewStates.set(`${groupId}|${prevPath}`, editor.saveViewState())
    setReady(null)
    void openDoc(path).then(r => {
      if (cancelled || r.kind !== 'text') return
      editor.setModel(r.doc.model)
      const vs = viewStates.get(`${groupId}|${path}`)
      if (vs) editor.restoreViewState(vs)
      setReady(path)
      if (focused) editor.focus()
      const pos = editor.getPosition(); const m = r.doc.model
      useEditor.getState().setStatus({ path, line: pos?.lineNumber ?? 1, col: pos?.column ?? 1, selected: 0, selLines: 0, language: m.getLanguageId(), eol: m.getEOL() === '\r\n' ? 'CRLF' : 'LF', tabSize: m.getOptions().tabSize, insertSpaces: m.getOptions().insertSpaces })
    })
    return () => { cancelled = true }
  }, [path, groupId]) // eslint-disable-line react-hooks/exhaustive-deps

  // reveal requests
  useEffect(() => {
    const editor = edRef.current
    if (!editor || ready !== path || !tab.reveal || tab.reveal.n === lastReveal.current) return
    lastReveal.current = tab.reveal.n
    editor.setPosition({ lineNumber: tab.reveal.line, column: tab.reveal.col })
    editor.revealLineInCenter(tab.reveal.line)
    editor.focus()
  }, [tab.reveal, ready, path])

  useEffect(() => { if (focused && ready) edRef.current?.focus() }, [focused, ready])

  // options from settings
  useEffect(() => {
    edRef.current?.updateOptions({
      fontFamily: ed.fontFamily, fontSize: ed.fontSize, lineHeight: Math.round(ed.fontSize * ed.lineHeight), wordWrap: ed.wordWrap, minimap: { enabled: ed.minimap, renderCharacters: false, maxColumn: 100 },
      cursorStyle: ed.cursorStyle, cursorBlinking: ed.cursorBlinking, lineNumbers: ed.lineNumbers, renderWhitespace: ed.renderWhitespace, bracketPairColorization: { enabled: ed.bracketPairColorization },
      fontLigatures: ed.ligatures, stickyScroll: { enabled: ed.stickyScroll }, folding: ed.folding, smoothScrolling: ed.smoothScrolling, tabSize: ed.tabSize, insertSpaces: ed.insertSpaces
    })
  }, [ed, ready])

  // git gutter
  useEffect(() => {
    const editor = edRef.current
    if (!editor || ready !== path) return
    const model = editor.getModel()
    if (!model) return
    let cancelled = false
    const update = async () => {
      const base = await headContent(path)
      if (cancelled || editor.getModel() !== model) return
      if (base === null) { decoRef.current?.clear(); return }
      const decos: monaco.editor.IModelDeltaDecoration[] = []
      let line = 1
      const parts = diffLines(base, model.getValue())
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        const n = p.count ?? 0
        if (p.removed) {
          const next = parts[i + 1]
          if (next?.added) { decos.push({ range: new monaco.Range(line, 1, line + (next.count ?? 1) - 1, 1), options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-modified' } }); line += next.count ?? 0; i++ }
          else decos.push({ range: new monaco.Range(Math.max(1, line - 1 || 1), 1, Math.max(1, line - 1 || 1), 1), options: { linesDecorationsClassName: 'git-gutter-deleted' } })
        } else if (p.added) { decos.push({ range: new monaco.Range(line, 1, line + n - 1, 1), options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-added' } }); line += n }
        else line += n
      }
      decoRef.current?.set(decos)
    }
    const deb = debounce(() => { void update() }, 500)
    const sub = model.onDidChangeContent(() => deb())
    void update()
    const unsub = useGit.subscribe((s, p) => { if (s.status?.head !== p.status?.head || s.status?.files.length !== p.status?.files.length) { gitBase.delete(path); void update() } })
    return () => { cancelled = true; sub.dispose(); deb.cancel(); unsub() }
  }, [path, ready])

  // breakpoints & current debug line
  const bps = useDebug(s => s.breakpoints[path])
  const snap = useDebug(s => s.snapshot)
  useEffect(() => {
    const frame = snap.state === 'paused' ? snap.frames[0] : undefined
    const decos: monaco.editor.IModelDeltaDecoration[] = (bps ?? []).map(b => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: `bp-glyph${b.condition || b.logMessage ? ' cond' : ''}${!b.enabled ? ' disabled' : ''}`, glyphMarginHoverMessage: { value: b.logMessage ? `Logpoint: ${b.logMessage}` : b.condition ? `Condition: ${b.condition}` : 'Breakpoint' } } }))
    if (frame && frame.path.toLowerCase() === path.toLowerCase()) decos.push({ range: new monaco.Range(frame.line, 1, frame.line, 1), options: { isWholeLine: true, className: 'debug-line', glyphMarginClassName: 'debug-glyph' } })
    bpRef.current?.set(decos)
    if (frame && frame.path.toLowerCase() === path.toLowerCase() && ready === path) edRef.current?.revealLineInCenterIfOutsideViewport(frame.line)
  }, [bps, snap, path, ready])

  return (
    <>
      {external && (
        <div className="editor-banner">
          <span className="grow">{external === 'deleted' ? 'This file was deleted on disk.' : 'This file changed on disk, and you have unsaved changes.'}</span>
          {external === 'changed' && <Button size="sm" onClick={() => void reloadDoc(path)}>Reload from disk</Button>}
          <Button size="sm" variant="secondary" onClick={() => { keepLocal(path); if (external === 'deleted') void saveDoc(path).catch(e => toast.error((e as Error).message)) }}>{external === 'deleted' ? 'Recreate file' : 'Keep my changes'}</Button>
        </div>
      )}
      <div className="editor-host" ref={host} data-testid="code-editor" />
    </>
  )
}
void getDoc
