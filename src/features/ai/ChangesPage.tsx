import { useEffect, useState } from 'react'
import { Check, ExternalLink, FileDiff, FilePlus2, Trash2, Undo2, FilePen, Redo2 } from 'lucide-react'
import type { FileChange } from '@shared/ai'
import { api } from '../../lib/api'
import { cn, relativeTo } from '../../lib/util'
import { Button, EmptyState } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'
import { dialogs, toast } from '../../stores/ui'
import { DiffLines } from './ToolCards'
import { FileIcon } from '../../lib/icons'

const STATUS = { created: { label: 'New', cls: 'success', icon: FilePlus2 }, modified: { label: 'Modified', cls: 'info', icon: FilePen }, deleted: { label: 'Deleted', cls: 'danger', icon: Trash2 } } as const

export function ChangesPage({ sessionId }: { sessionId: string }) {
  const changes = useAi(s => s.changes[sessionId]) ?? []
  const title = useAi(s => s.data[sessionId]?.title)
  const running = useAi(s => !!s.running[sessionId])
  const root = useWorkspace(s => s.root)
  const [canRedo, setCanRedo] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  useEffect(() => { void api.ai.changes.list(sessionId).then(c => useAi.setState(s => ({ changes: { ...s.changes, [sessionId]: c } }))); void api.ai.changes.canRedo(sessionId).then(setCanRedo) }, [sessionId, changes.length])
  const added = changes.reduce((n, c) => n + c.added, 0), removed = changes.reduce((n, c) => n + c.removed, 0)
  const refresh = async () => { const c = await api.ai.changes.list(sessionId); useAi.setState(s => ({ changes: { ...s.changes, [sessionId]: c } })); setCanRedo(await api.ai.changes.canRedo(sessionId)) }
  const revert = async (c: FileChange) => { if (!(await dialogs.confirm({ title: `Revert ${c.rel}?`, message: 'The file goes back to how it was before the agent first changed it.', confirmLabel: 'Revert', danger: true }))) return; await api.ai.changes.revertFile(sessionId, c.path); await refresh(); toast.success(`Reverted ${c.rel}`) }
  const undoAll = async () => { if (!(await dialogs.confirm({ title: 'Undo all agent changes?', message: `${changes.length} file(s) are restored to their original state.`, confirmLabel: 'Undo all', danger: true }))) return; const r = await api.ai.changes.undoFromTurn(sessionId, null); await refresh(); toast.success(`Reverted ${r.files.length} file(s).`) }
  const redo = async () => { const r = await api.ai.changes.redo(sessionId); await refresh(); toast.success(`Re-applied ${r.files.length} file(s).`) }
  return <div className="page-scroll"><div className="page narrow">
    <div className="page-head"><div><h1 className="serif">Changes</h1><p className="page-sub">{title ? <>Files edited by the agent in <b>{title}</b>.</> : 'Files edited by the agent.'}</p></div>
      <div className="row gap8">
        {canRedo && <Button icon={Redo2} onClick={() => void redo()}>Redo</Button>}
        <Button icon={Undo2} disabled={!changes.length || running} onClick={() => void undoAll()}>Undo all</Button>
        <Button variant="primary" icon={Check} disabled={!changes.length} onClick={() => void api.ai.changes.accept(sessionId).then(refresh)}>Keep all</Button>
      </div></div>
    {!changes.length ? <EmptyState icon={FileDiff} title="No changes to review" text="When the agent edits files, every change shows up here with a diff you can keep or revert." /> : <>
      <div className="stat-row"><span className="badge">{changes.length} file{changes.length > 1 ? 's' : ''}</span><span className="ok">+{added}</span><span className="err">−{removed}</span></div>
      {changes.map(c => { const st = STATUS[c.status]; const hide = collapsed[c.path]; return <div key={c.path} className="card change-card">
        <div className="cc-top" onClick={() => setCollapsed(x => ({ ...x, [c.path]: !hide }))}>
          <FileIcon name={c.rel} size={16} /><span className="cc-name truncate">{c.rel}</span><span className={cn('badge', st.cls)}>{st.label}</span><span className="ok small">+{c.added}</span><span className="err small">−{c.removed}</span><span className="grow" />
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={e => { e.stopPropagation(); useEditor.getState().openDiff({ mode: 'agent', path: c.path, original: c.before ?? '', modified: c.after ?? '', originalLabel: 'Before', modifiedLabel: 'After', readOnly: true, sessionId }) }}>Diff</Button>
          {c.status !== 'deleted' && <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); void useEditor.getState().openFile(c.path, { pin: true }) }}>Open</Button>}
          <Button size="sm" variant="ghost" icon={Undo2} onClick={e => { e.stopPropagation(); void revert(c) }}>Revert</Button>
        </div>
        {!hide && <DiffLines before={c.before ?? ''} after={c.after ?? ''} context={3} maxLines={160} />}
      </div> })}
    </>}
    <div className="subtle small" style={{ marginTop: 16 }}>{root ? `Paths are relative to ${relativeTo(null, root)}.` : ''}</div>
  </div></div>
}
