import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronRight, Columns2, Pin, Rows2, X, MoreHorizontal, FileText, MessageSquare } from 'lucide-react'
import { useEditor, CHAT_TAB_ID, type Group, type LayoutNode, type Tab } from '../../stores/editor'
import { useDocs } from '../../lib/docs'
import { useDiagnostics } from '../../lib/lsp-monaco'
import { useWorkspace } from '../../stores/workspace'
import { cn, copyText, relativeTo, dirname, basename, clamp } from '../../lib/util'
import { FileIcon } from '../../lib/icons'
import { IconButton, MenuButton, Resizer, useContextMenu } from '../../components/ui'
import { api } from '../../lib/api'
import { runCommand } from '../../lib/commands'
import { CodeEditor } from './CodeEditor'
import { DiffView } from './DiffView'
import { BinaryNotice, ImageViewer, MediaViewer } from './Viewers'
import { PageHost } from './PageHost'
import { Breadcrumbs } from './Breadcrumbs'
import { MainChat } from '../ai/MainChat'
import { useAi } from '../../stores/ai'
import { toast } from '../../stores/ui'

const DND = 'application/x-tgg-tab'

function TabItem({ group, tab, active, index }: { group: Group; tab: Tab; active: boolean; index: number }) {
  const dirty = useDocs(s => (tab.path && tab.kind === 'file' ? !!s.dirty[tab.path] : false))
  const deleted = useDocs(s => (tab.path ? s.external[tab.path] === 'deleted' : false))
  const errors = useDiagnostics(s => (tab.path && tab.kind === 'file' ? (s.byPath[tab.path] ?? []).filter(d => d.severity === 'error').length : 0))
  const root = useWorkspace(s => s.root)
  const isChat = tab.id === CHAT_TAB_ID
  // a pulsing dot on the Chat tab tells you the agent is working (or needs an answer) while you look at files
  const chatState = useAi(s => (!isChat ? null : s.permissions.length || s.questions.length ? 'ask' : Object.values(s.running).some(Boolean) ? 'run' : null))
  const ed = useEditor.getState()
  const ctx = useContextMenu()
  const [drop, setDrop] = useState<'before' | 'after' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [active])
  const closeOthers = () => ed.closeMany(group.id, group.tabs.filter(t => t.id !== tab.id && !t.pinned).map(t => t.id))
  const items = () => isChat ? [{ label: 'New chat', onClick: () => { void useAi.getState().newChat(); ed.activate(group.id, tab.id) } }] : [
    { label: 'Close', hint: 'Ctrl+W', onClick: () => void ed.closeTab(group.id, tab.id) },
    { label: 'Close Others', disabled: group.tabs.length < 2, onClick: () => void closeOthers() },
    { label: 'Close to the Right', disabled: index >= group.tabs.length - 1, onClick: () => void ed.closeMany(group.id, group.tabs.slice(index + 1).filter(t => !t.pinned).map(t => t.id)) },
    { label: 'Close Saved', onClick: () => void ed.closeMany(group.id, group.tabs.filter(t => !t.pinned && !(t.path && useDocs.getState().dirty[t.path])).map(t => t.id)) },
    { label: 'Close All', onClick: () => void ed.closeMany(group.id, group.tabs.filter(t => !t.pinned).map(t => t.id)) },
    { separator: true },
    { label: tab.pinned ? 'Unpin' : 'Pin', onClick: () => ed.pinTab(group.id, tab.id, !tab.pinned) },
    ...(tab.path ? [
      { separator: true }, { label: 'Copy Path', onClick: () => void copyText(tab.path!) }, { label: 'Copy Relative Path', onClick: () => void copyText(relativeTo(root, tab.path!)) },
      { label: 'Reveal in File Explorer', onClick: () => void api.fs.reveal(tab.path!) }, { label: 'Reveal in Explorer Panel', onClick: () => { void useWorkspace.getState().expandTo(tab.path!); runCommand('view.explorer') } },
      { separator: true }, { label: 'Split Right', onClick: () => { ed.activate(group.id, tab.id); ed.split('row', group.id) } }, { label: 'Split Down', onClick: () => { ed.activate(group.id, tab.id); ed.split('col', group.id) } }
    ] : [])
  ]
  const onDragOver = (e: DragEvent) => { if (!e.dataTransfer.types.includes(DND)) return; e.preventDefault(); e.stopPropagation(); const r = ref.current!.getBoundingClientRect(); setDrop(e.clientX < r.left + r.width / 2 ? 'before' : 'after') }
  return (
    <div ref={ref} className={cn('tab', active && 'active', tab.preview && 'preview', drop && `drop-${drop}`)} draggable role="tab" aria-selected={active}
      onClick={() => ed.activate(group.id, tab.id)} onDoubleClick={() => ed.keepOpen(group.id, tab.id)} onAuxClick={e => { if (e.button === 1) { e.preventDefault(); void ed.closeTab(group.id, tab.id) } }}
      onContextMenu={e => ctx(e, items())} data-tip={tab.path ? relativeTo(root, tab.path) : undefined} data-tip-pos="below"
      onDragStart={e => { e.dataTransfer.setData(DND, JSON.stringify({ groupId: group.id, tabId: tab.id })); e.dataTransfer.effectAllowed = 'move' }}
      onDragOver={onDragOver} onDragLeave={() => setDrop(null)}
      onDrop={e => { const raw = e.dataTransfer.getData(DND); setDrop(null); if (!raw) return; e.preventDefault(); e.stopPropagation(); const d = JSON.parse(raw) as { groupId: string; tabId: string }; const r = ref.current!.getBoundingClientRect(); ed.moveTab(d.groupId, d.tabId, group.id, e.clientX < r.left + r.width / 2 ? index : index + 1) }}>
      {isChat ? <MessageSquare size={14} className="subtle" /> : tab.kind === 'page' ? <FileText size={14} className="subtle" /> : tab.kind === 'diff' ? <FileIcon name={tab.path ?? tab.title} size={14} /> : <FileIcon name={tab.title} size={15} />}
      <span className={cn('tab-title', deleted && 'deleted')}>{tab.title}</span>
      {errors > 0 && <span className="tab-err" />}
      {chatState && <span className={cn('tab-chat-dot', chatState === 'ask' && 'ask')} data-tip={chatState === 'ask' ? 'The agent is waiting for you' : 'The agent is working'} />}
      {tab.pinned && !isChat && <Pin size={11} className="tab-pin" />}
      {dirty ? <span className="tab-dirty" /> : null}
      {!tab.pinned && <button className="tab-close" onClick={e => { e.stopPropagation(); void ed.closeTab(group.id, tab.id) }} aria-label="Close tab" style={dirty ? undefined : undefined}><X size={13} /></button>}
    </div>
  )
}

function GroupView({ group, single }: { group: Group; single: boolean }) {
  const activeGroup = useEditor(s => s.activeGroup)
  const ed = useEditor.getState()
  const tab = group.tabs.find(t => t.id === group.activeId) ?? null
  const focused = activeGroup === group.id
  const [zone, setZone] = useState<'center' | 'left' | 'right' | 'top' | 'bottom' | null>(null)
  const body = useRef<HTMLDivElement>(null)

  const dragOver = (e: DragEvent) => {
    const hasTab = e.dataTransfer.types.includes(DND), hasPath = e.dataTransfer.types.includes('application/x-tgg-path'), hasFiles = e.dataTransfer.types.includes('Files')
    if (!hasTab && !hasPath && !hasFiles) return
    e.preventDefault()
    const r = body.current!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
    setZone(x < 0.2 ? 'left' : x > 0.8 ? 'right' : y < 0.2 ? 'top' : y > 0.8 ? 'bottom' : 'center')
  }
  const drop = async (e: DragEvent) => {
    e.preventDefault(); const z = zone; setZone(null)
    const move = (gid: string) => { const raw = e.dataTransfer.getData(DND); if (raw) { const d = JSON.parse(raw) as { groupId: string; tabId: string }; ed.moveTab(d.groupId, d.tabId, gid) } }
    const open = async (gid: string) => {
      const p = e.dataTransfer.getData('application/x-tgg-path')
      if (p) { await ed.openFile(p, { pin: true, group: gid }); return }
      for (const f of Array.from(e.dataTransfer.files)) { const fp = window.tgg.pathForFile(f); if (fp) await ed.openFile(fp, { pin: true, group: gid }) }
    }
    let gid = group.id
    if (z && z !== 'center') {
      ed.focusGroup(group.id)
      const before = Object.keys(useEditor.getState().groups)
      ed.split(z === 'left' || z === 'right' ? 'row' : 'col', group.id)
      gid = Object.keys(useEditor.getState().groups).find(k => !before.includes(k)) ?? group.id
      if (z === 'left' || z === 'top') { /* new group is placed after; acceptable */ }
      const g = useEditor.getState().groups[gid]
      if (g && e.dataTransfer.types.includes('Files') || e.dataTransfer.getData('application/x-tgg-path')) await ed.closeTab(gid, g.activeId ?? '', true)
    }
    if (e.dataTransfer.types.includes(DND)) move(gid); else await open(gid)
  }

  return (
    <div className={cn('group', focused && 'focused', zone && 'drop-target')} onMouseDown={() => ed.focusGroup(group.id)} onDragOver={dragOver} onDragLeave={e => { if (!body.current?.contains(e.relatedTarget as Node)) setZone(null) }} onDrop={drop} ref={body}
      style={zone && zone !== 'center' ? undefined : undefined}>
      <div className="tabbar" role="tablist" onDoubleClick={e => { if (e.target === e.currentTarget) runCommand('file.newFile') }}
        onDragOver={e => { if (e.dataTransfer.types.includes(DND)) e.preventDefault() }} onDrop={e => { const raw = e.dataTransfer.getData(DND); if (raw && e.target === e.currentTarget) { e.preventDefault(); const d = JSON.parse(raw) as { groupId: string; tabId: string }; ed.moveTab(d.groupId, d.tabId, group.id) } }}>
        <div className="tabs-scroll" onWheel={e => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY }} onDragOver={e => { if (e.dataTransfer.types.includes(DND)) e.preventDefault() }}
          onDrop={e => { const raw = e.dataTransfer.getData(DND); if (raw && e.target === e.currentTarget) { e.preventDefault(); const d = JSON.parse(raw) as { groupId: string; tabId: string }; ed.moveTab(d.groupId, d.tabId, group.id) } }}>
          {group.tabs.map((t, i) => <TabItem key={t.id} group={group} tab={t} active={t.id === group.activeId} index={i} />)}
        </div>
        <div className="tabbar-actions">
          <IconButton icon={Columns2} tip="Split editor right" kbd="Ctrl+\" size="sm" onClick={() => ed.split('row', group.id)} />
          <MenuButton icon={MoreHorizontal} tip="More actions" size="sm" placement="bottom-end" items={[
            { label: 'Split Right', onClick: () => ed.split('row', group.id) }, { label: 'Split Down', onClick: () => ed.split('col', group.id) }, { separator: true },
            { label: 'Close All Tabs in Group', onClick: () => void ed.closeMany(group.id, group.tabs.filter(t => !t.pinned).map(t => t.id)) }, { label: 'Reopen Closed Editor', onClick: () => ed.reopenClosed() }]} />
        </div>
      </div>
      {tab?.kind === 'file' && <Breadcrumbs tab={tab} />}
      {!tab ? (single ? <MainChat /> : <div className="editor-empty"><span>Drop a file here</span></div>) :
        tab.kind === 'file' ? <CodeEditor key={group.id} groupId={group.id} tab={tab} focused={focused} /> :
        tab.kind === 'diff' ? <DiffView key={tab.id} tab={tab} groupId={group.id} /> :
        tab.kind === 'image' ? <ImageViewer tab={tab} /> :
        tab.kind === 'media' ? <MediaViewer tab={tab} /> :
        tab.kind === 'binary' ? <BinaryNotice tab={tab} /> :
        <PageHost tab={tab} />}
      {zone && zone !== 'center' && <div style={{ position: 'absolute', zIndex: 6, pointerEvents: 'none', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', border: '2px solid var(--accent)', borderRadius: 6, ...({ left: { left: 0, top: 0, bottom: 0, width: '50%' }, right: { right: 0, top: 0, bottom: 0, width: '50%' }, top: { left: 0, right: 0, top: 0, height: '50%' }, bottom: { left: 0, right: 0, bottom: 0, height: '50%' } } as Record<string, React.CSSProperties>)[zone] }} />}
    </div>
  )
}

function Node({ node, single }: { node: LayoutNode; single: boolean }) {
  const groups = useEditor(s => s.groups)
  const ed = useEditor.getState()
  const ref = useRef<HTMLDivElement>(null)
  if (node.type === 'leaf') { const g = groups[node.groupId]; return g ? <GroupView group={g} single={single} /> : null }
  const horizontal = node.dir === 'row'
  const onDrag = (i: number, delta: number) => {
    const total = horizontal ? ref.current!.clientWidth : ref.current!.clientHeight
    const sizes = [...node.sizes]
    const d = delta / total
    const a = clamp(sizes[i] + d, 0.1, 0.9), b = clamp(sizes[i + 1] - d, 0.1, 0.9)
    if (Math.abs(a + b - (sizes[i] + sizes[i + 1])) > 1e-6) return
    sizes[i] = a; sizes[i + 1] = b
    ed.setSizes(node.id, sizes)
  }
  return (
    <div ref={ref} className={cn('split', !horizontal && 'col')}>
      {node.children.map((c, i) => (
        <Fragment key={c.type === 'leaf' ? c.groupId : c.id}>
          <div className="cell" style={{ flex: `${node.sizes[i] ?? 1} 1 0`, borderLeft: horizontal && i > 0 ? '1px solid var(--border)' : undefined, borderTop: !horizontal && i > 0 ? '1px solid var(--border)' : undefined }}><Node node={c} single={false} /></div>
          {i < node.children.length - 1 && <Resizer dir={horizontal ? 'v' : 'h'} onDrag={d => onDrag(i, d)} />}
        </Fragment>
      ))}
    </div>
  )
}

export function EditorArea() {
  const layout = useEditor(s => s.layout)
  return <div className="editor-area"><Node node={layout} single={layout.type === 'leaf'} /></div>
}
void ChevronRight; void Rows2; void dirname; void basename; void useAi; void toast
