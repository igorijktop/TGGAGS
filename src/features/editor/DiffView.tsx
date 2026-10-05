import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Columns2, Rows2, Undo2, Check, Plus, Minus } from 'lucide-react'
import { monaco } from '../../lib/monaco'
import { api } from '../../lib/api'
import { openDoc } from '../../lib/docs'
import { languageForPath } from '@shared/languages'
import { useEditor, type Tab } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useAi } from '../../stores/ai'
import { Button, IconButton, Spinner } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { basename, relativeTo } from '../../lib/util'
import { useWorkspace } from '../../stores/workspace'

export function DiffView({ tab, groupId }: { tab: Tab; groupId: string }) {
  const spec = tab.diff!
  const host = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [inline, setInline] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'binary' | 'error'>('loading')
  const [labels, setLabels] = useState({ o: spec.originalLabel ?? '', m: spec.modifiedLabel ?? '' })
  const root = useWorkspace(s => s.root)
  const git = useGit()

  useEffect(() => {
    let cancelled = false
    const models: monaco.editor.ITextModel[] = []
    const editor = monaco.editor.createDiffEditor(host.current!, { automaticLayout: true, renderSideBySide: !inline, readOnly: spec.mode !== 'unstaged', originalEditable: false, ignoreTrimWhitespace: false, renderIndicators: true, scrollBeyondLastLine: false, padding: { top: 8 }, fixedOverflowWidgets: true, enableSplitViewResizing: true, minimap: { enabled: false } })
    edRef.current = editor
    ;(async () => {
      try {
        const lang = languageForPath(spec.path)
        let original = spec.original, modified = spec.modified
        let modifiedModel: monaco.editor.ITextModel | null = null
        if (spec.mode === 'staged' || spec.mode === 'unstaged' || spec.mode === 'commit') {
          const rel = relativeTo(git.status?.root ?? root, spec.path)
          const sides = await api.git.diffSides(rel, spec.mode, spec.commit)
          if (cancelled) return
          if (sides.binary) { setState('binary'); return }
          original = sides.original; modified = sides.modified
          setLabels({ o: sides.originalLabel, m: sides.modifiedLabel })
          if (spec.mode === 'unstaged') { const r = await openDoc(spec.path); if (r.kind === 'text') modifiedModel = r.doc.model }
        }
        const om = monaco.editor.createModel(original ?? '', lang); models.push(om)
        let mm = modifiedModel
        if (!mm) { mm = monaco.editor.createModel(modified ?? '', lang); models.push(mm) }
        editor.setModel({ original: om, modified: mm })
        setState('ready')
      } catch (e) { toast.error((e as Error).message); setState('error') }
    })()
    return () => { cancelled = true; editor.setModel(null); models.forEach(m => m.dispose()); editor.dispose(); edRef.current = null }
  }, [spec.mode, spec.path, spec.commit, spec.original, spec.modified, inline]) // eslint-disable-line react-hooks/exhaustive-deps

  const rel = relativeTo(root, spec.path)
  const stageFile = async () => { await git.run('stage', () => api.git.stage([relativeTo(git.status?.root ?? root, spec.path)])); void useEditor.getState().closeTab(groupId, tab.id, true) }
  const unstageFile = async () => { await git.run('unstage', () => api.git.unstage([relativeTo(git.status?.root ?? root, spec.path)])); void useEditor.getState().closeTab(groupId, tab.id, true) }
  const discardFile = async () => {
    if (!(await dialogs.confirm({ title: `Discard changes to ${basename(spec.path)}?`, message: 'This permanently reverts the file to its last committed state.', confirmLabel: 'Discard changes', danger: true }))) return
    await git.run('discard', () => api.git.discard([relativeTo(git.status?.root ?? root, spec.path)])); void useEditor.getState().closeTab(groupId, tab.id, true)
  }
  const revertAi = async () => { if (spec.sessionId) { await api.ai.changes.revertFile(spec.sessionId, spec.path); toast.success(`Reverted ${basename(spec.path)}`); void useEditor.getState().closeTab(groupId, tab.id, true) } }
  void useAi

  return (
    <>
      <div className="diff-toolbar">
        <span className="truncate" style={{ fontWeight: 500 }}>{rel}</span>
        <span className="subtle small truncate">{labels.o && labels.m ? `${labels.o} ↔ ${labels.m}` : ''}</span>
        <div className="grow" />
        <IconButton icon={ArrowUp} tip="Previous change" size="sm" onClick={() => edRef.current?.goToDiff('previous')} />
        <IconButton icon={ArrowDown} tip="Next change" size="sm" onClick={() => edRef.current?.goToDiff('next')} />
        <IconButton icon={inline ? Columns2 : Rows2} tip={inline ? 'Side by side' : 'Inline'} size="sm" onClick={() => setInline(!inline)} />
        {spec.mode === 'unstaged' && <><Button size="sm" variant="secondary" icon={Plus} onClick={stageFile}>Stage</Button><Button size="sm" variant="ghost" icon={Undo2} onClick={discardFile}>Discard</Button></>}
        {spec.mode === 'staged' && <Button size="sm" variant="secondary" icon={Minus} onClick={unstageFile}>Unstage</Button>}
        {spec.mode === 'agent' && <><Button size="sm" variant="ghost" icon={Undo2} onClick={revertAi}>Revert this file</Button><Button size="sm" variant="soft" icon={Check} onClick={() => useEditor.getState().closeTab(groupId, tab.id, true)}>Done</Button></>}
      </div>
      {state === 'loading' && <div className="center grow"><Spinner size={18} /></div>}
      {state === 'binary' && <div className="editor-empty">Binary file – no text diff available.</div>}
      <div className="editor-host" ref={host} style={{ display: state === 'ready' ? undefined : 'none' }} />
    </>
  )
}
