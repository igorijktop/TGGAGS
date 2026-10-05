import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ChevronRight, FilePlus, FolderPlus, RefreshCw, ChevronsDownUp, FolderOpen, GitFork, Search } from 'lucide-react'
import { useWorkspace } from '../../stores/workspace'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useAi } from '../../stores/ai'
import { useDiagnostics } from '../../lib/lsp-monaco'
import { api } from '../../lib/api'
import { FileIcon } from '../../lib/icons'
import { cn, copyText, relativeTo, basename, dirname, joinPath, fuzzy } from '../../lib/util'
import { Button, EmptyState, Highlight, IconButton, useContextMenu } from '../../components/ui'
import { dialogs, toast, useUi } from '../../stores/ui'
import { runCommand } from '../../lib/commands'
import type { FileEntry } from '@shared/fs'

interface Editing { kind: 'rename' | 'file' | 'dir'; path: string }

function GitBadge({ letter }: { letter: string }) {
  const color = letter === 'M' ? 'var(--info)' : letter === 'A' || letter === 'U' ? 'var(--success)' : letter === 'D' ? 'var(--danger)' : letter === 'C' ? 'var(--danger)' : 'var(--fg-muted)'
  return <span className="tree-badge" style={{ color }}>{letter}</span>
}

export function Explorer() {
  const ws = useWorkspace()
  const git = useGit(s => s.status)
  const diag = useDiagnostics(s => s.byPath)
  const activePath = useEditor(s => { const g = s.groups[s.activeGroup]; return g?.tabs.find(t => t.id === g.activeId)?.path ?? null })
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [filter, setFilter] = useState('')
  const [dropDir, setDropDir] = useState<string | null>(null)
  const ctx = useContextMenu()
  const treeRef = useRef<HTMLDivElement>(null)

  // git status lookup (abs path → letter) and changed-dir set
  const { gitMap, dirty } = useMemo(() => {
    const m = new Map<string, string>(); const dirs = new Set<string>()
    if (git?.isRepo) for (const f of git.files) {
      const abs = joinPath(git.root, f.path).replace(/\//g, git.root.includes('\\') ? '\\' : '/')
      const letter = f.conflict ? 'C' : f.untracked ? 'U' : f.index !== '.' && f.index !== ' ' ? f.index : f.worktree
      m.set(abs, letter)
      let d = dirname(abs)
      while (d.length > git.root.length) { dirs.add(d); d = dirname(d) }
    }
    return { gitMap: m, dirty: dirs }
  }, [git])

  const errorDirs = useMemo(() => { const s = new Set<string>(); for (const [p, l] of Object.entries(diag)) if (l.some(d => d.severity === 'error')) { let d = dirname(p); while (d.length > (ws.root?.length ?? 0)) { s.add(d); d = dirname(d) } } return s }, [diag, ws.root])

  useEffect(() => { if (activePath && ws.root) { void ws.expandTo(activePath); setSelected([activePath]) } }, [activePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const [filtered, setFiltered] = useState<{ rel: string; indices: number[] }[]>([])
  useEffect(() => {
    if (!filter) { setFiltered([]); return }
    let cancelled = false
    void ws.fileList().then(files => { if (cancelled) return; setFiltered(files.map(f => ({ rel: f, m: fuzzy(filter, f) })).filter(x => x.m).sort((a, b) => b.m!.score - a.m!.score).slice(0, 200).map(x => ({ rel: x.rel, indices: x.m!.indices }))) })
    return () => { cancelled = true }
  }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ws.root) {
    const recent = useRecent()
    return (
      <div className="sb-body">
        <EmptyState icon={FolderOpen} title="No folder open" text="Open a project folder to browse files, use Git, and let the AI work on your code.">
          <div className="col gap8" style={{ width: '100%', maxWidth: 220, marginTop: 8 }}>
            <Button variant="primary" icon={FolderOpen} onClick={() => runCommand('file.openFolder')}>Open Folder</Button>
            <Button icon={GitFork} onClick={() => runCommand('git.clone')}>Clone Repository</Button>
          </div>
        </EmptyState>
        {recent.length > 0 && <div className="sb-pad"><div className="section-title" style={{ margin: '4px 4px 6px' }}>Recent</div>{recent.map(p => <div key={p} className="sb-item" style={{ margin: 0 }} onClick={() => void ws.open(p)} data-tip={p}><FolderOpen size={14} className="subtle" /><span className="truncate">{basename(p)}</span></div>)}</div>}
      </div>
    )
  }

  const open = (e: FileEntry, preview: boolean) => { if (e.isDir) void ws.toggle(e.path); else void useEditor.getState().openFile(e.path, { preview, pin: !preview }) }

  const commitEdit = async (value: string | null) => {
    const ed = editing; setEditing(null)
    if (!ed || value === null || !value.trim()) return
    const name = value.trim()
    try {
      if (ed.kind === 'rename') {
        const to = joinPath(dirname(ed.path), name)
        if (to === ed.path) return
        await api.fs.rename(ed.path, to)
        useEditor.getState().renamePath(ed.path, to)
        await ws.loadDir(dirname(ed.path), true)
      } else {
        const target = joinPath(ed.path, name)
        if (ed.kind === 'dir') await api.fs.createDir(target); else { await api.fs.createFile(target); void useEditor.getState().openFile(target, { pin: true }) }
        await ws.loadDir(ed.path, true); await ws.expandTo(target)
      }
    } catch (e) { toast.error((e as Error).message.replace(/^Error invoking.*?: /, '')) }
  }

  const remove = async (paths: string[]) => {
    const ok = await dialogs.confirm({ title: paths.length === 1 ? `Delete "${basename(paths[0])}"?` : `Delete ${paths.length} items?`, message: 'They will be moved to the recycle bin / trash.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    for (const p of paths) { try { await api.fs.delete(p); useEditor.getState().removePath(p) } catch (e) { toast.error((e as Error).message) } }
    for (const d of new Set(paths.map(dirname))) await ws.loadDir(d, true)
  }

  const addToChat = async (paths: string[]) => { for (const p of paths) await useAi.getState().addContext(await api.ai.context.describe(p)); useUi.getState().set({ aiVisible: true }); toast.info(`Added ${paths.length === 1 ? basename(paths[0]) : paths.length + ' items'} to the AI context`) }

  const menuFor = (e: FileEntry | null) => {
    const targets = e && selected.includes(e.path) && selected.length > 1 ? selected : e ? [e.path] : []
    const dir = e ? (e.isDir ? e.path : dirname(e.path)) : ws.root!
    const items: import('../../stores/ui').MenuEntry[] = [
      { label: 'New File…', onClick: () => { void ws.toggle(dir).then(() => { if (!useWorkspace.getState().expanded[dir]) void ws.toggle(dir) }); setEditing({ kind: 'file', path: dir }) } },
      { label: 'New Folder…', onClick: () => { if (!ws.expanded[dir]) void ws.toggle(dir); setEditing({ kind: 'dir', path: dir }) } }
    ]
    if (e) items.push(
      { separator: true },
      ...(e.isDir ? [] : [{ label: 'Open', onClick: () => open(e, false) }, { label: 'Open to the Side', onClick: () => { useEditor.getState().split('row'); void useEditor.getState().openFile(e.path, { pin: true }) } }]),
      { label: 'Add to AI Chat', onClick: () => void addToChat(targets) },
      { separator: true },
      { label: 'Rename', hint: 'F2', onClick: () => setEditing({ kind: 'rename', path: e.path }) },
      { label: 'Duplicate', onClick: async () => { try { const d = await api.fs.duplicate(e.path); await ws.loadDir(dirname(e.path), true); if (!e.isDir) void useEditor.getState().openFile(d, { pin: true }) } catch (er) { toast.error((er as Error).message) } } },
      { label: 'Delete', hint: 'Del', danger: true, onClick: () => void remove(targets) },
      { separator: true },
      { label: 'Copy Path', onClick: () => void copyText(e.path) }, { label: 'Copy Relative Path', onClick: () => void copyText(relativeTo(ws.root, e.path)) },
      { label: 'Reveal in File Explorer', onClick: () => void api.fs.reveal(e.path) },
      { label: 'Open in Terminal', onClick: () => { void api.terminal.create({ cwd: e.isDir ? e.path : dirname(e.path) }).then(() => useUi.getState().togglePanel('terminal')) } }
    )
    items.push({ separator: true }, { label: 'Refresh', onClick: () => void ws.refresh() }, { label: 'Collapse All', onClick: () => ws.collapseAll() })
    return items
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || (e.target as HTMLElement).tagName === 'INPUT') return
    const sel = selected[0]
    if (e.key === 'F2' && sel) setEditing({ kind: 'rename', path: sel })
    else if (e.key === 'Delete' && selected.length) void remove(selected)
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && treeRef.current) {
      e.preventDefault()
      const rows = Array.from(treeRef.current.querySelectorAll<HTMLElement>('[data-path]'))
      const i = rows.findIndex(r => r.dataset.path === sel)
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { setSelected([next.dataset.path!]); next.scrollIntoView({ block: 'nearest' }) }
    } else if (e.key === 'Enter' && sel) { const el = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(sel)}"]`); el?.click() }
    else if (e.key === 'ArrowRight' && sel && ws.entries[sel] && !ws.expanded[sel]) void ws.toggle(sel)
    else if (e.key === 'ArrowLeft' && sel && ws.expanded[sel]) void ws.toggle(sel)
  }

  const dropOn = async (e: DragEvent, dir: string) => {
    e.preventDefault(); e.stopPropagation(); setDropDir(null)
    const src = e.dataTransfer.getData('application/x-tgg-path')
    try {
      if (src) { if (dirname(src) === dir || src === dir || dir.startsWith(src + '/') || dir.startsWith(src + '\\')) return; const to = await api.fs.move(src, dir); useEditor.getState().renamePath(src, to); await ws.loadDir(dirname(src), true); await ws.loadDir(dir, true) }
      else for (const f of Array.from(e.dataTransfer.files)) { const p = window.tgg.pathForFile(f); if (p) await api.fs.copyTo(p, dir); await ws.loadDir(dir, true) }
    } catch (er) { toast.error((er as Error).message) }
  }

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const list = ws.entries[dir]
    if (!list) return ws.loading[dir] ? <div className="tree-row subtle" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</div> : null
    return <>
      {editing && editing.kind !== 'rename' && editing.path === dir && <EditRow depth={depth} kind={editing.kind} initial="" onDone={commitEdit} />}
      {list.map(e => {
        const isOpen = !!ws.expanded[e.path]
        const letter = gitMap.get(e.path)
        const errs = !e.isDir ? (diag[e.path] ?? []).filter(d => d.severity === 'error').length : 0
        const isSel = selected.includes(e.path)
        if (editing?.kind === 'rename' && editing.path === e.path) return <EditRow key={e.path} depth={depth} kind="rename" initial={e.name} isDir={e.isDir} onDone={commitEdit} />
        return (
          <div key={e.path}>
            <div className={cn('tree-row', isSel && 'sel', e.path === activePath && 'current', dropDir === e.path && 'drop')} style={{ paddingLeft: 8 + depth * 14 }} data-path={e.path} draggable
              onClick={ev => { setSelected(ev.ctrlKey || ev.metaKey ? (selected.includes(e.path) ? selected.filter(s => s !== e.path) : [...selected, e.path]) : [e.path]); if (!(ev.ctrlKey || ev.metaKey)) open(e, true) }}
              onDoubleClick={() => { if (!e.isDir) open(e, false) }}
              onContextMenu={ev => { if (!selected.includes(e.path)) setSelected([e.path]); ctx(ev, menuFor(e)) }}
              onDragStart={ev => { ev.dataTransfer.setData('application/x-tgg-path', e.path); ev.dataTransfer.effectAllowed = 'copyMove' }}
              onDragOver={ev => { if (e.isDir && (ev.dataTransfer.types.includes('application/x-tgg-path') || ev.dataTransfer.types.includes('Files'))) { ev.preventDefault(); ev.stopPropagation(); setDropDir(e.path) } }}
              onDragLeave={() => setDropDir(d => (d === e.path ? null : d))}
              onDrop={ev => { if (e.isDir) void dropOn(ev, e.path) }}>
              {e.isDir ? <ChevronRight size={13} className={cn('tree-chev', isOpen && 'open')} /> : <span style={{ width: 13 }} />}
              <FileIcon name={e.name} dir={e.isDir} open={isOpen} size={16} />
              <span className={cn('tree-name truncate', letter === 'D' && 'deleted')} style={{ color: letter === 'U' || letter === 'A' ? 'var(--success)' : letter === 'M' ? 'var(--info)' : letter === 'D' || letter === 'C' ? 'var(--danger)' : undefined }}>{e.name}</span>
              {errs > 0 && <span className="tree-badge" style={{ color: 'var(--danger)' }} data-tip={`${errs} error${errs > 1 ? 's' : ''}`}>{errs}</span>}
              {letter && !e.isDir && <GitBadge letter={letter} />}
              {e.isDir && (errorDirs.has(e.path) ? <span className="tree-dot" style={{ background: 'var(--danger)' }} /> : dirty.has(e.path) ? <span className="tree-dot" style={{ background: 'var(--warning)' }} /> : null)}
            </div>
            {e.isDir && isOpen && renderDir(e.path, depth + 1)}
          </div>
        )
      })}
    </>
  }

  return (
    <>
      <div className="sb-head">
        <h2 className="truncate" data-tip={ws.root}>{ws.name}</h2>
        <IconButton icon={FilePlus} tip="New file" size="sm" onClick={() => setEditing({ kind: 'file', path: selected[0] && ws.entries[selected[0]] ? selected[0] : ws.root! })} />
        <IconButton icon={FolderPlus} tip="New folder" size="sm" onClick={() => setEditing({ kind: 'dir', path: selected[0] && ws.entries[selected[0]] ? selected[0] : ws.root! })} />
        <IconButton icon={RefreshCw} tip="Refresh" size="sm" onClick={() => void ws.refresh()} />
        <IconButton icon={ChevronsDownUp} tip="Collapse all" size="sm" onClick={() => ws.collapseAll()} />
      </div>
      <div className="sb-pad" style={{ paddingTop: 0 }}><div className="search-input"><Search size={13} /><input className="input sm" placeholder="Filter files…" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setFilter('') }} /></div></div>
      <div className="sb-body tree" ref={treeRef} tabIndex={0} onKeyDown={onKey} onContextMenu={e => { if (e.target === e.currentTarget) ctx(e, menuFor(null)) }}
        onDragOver={e => { if (e.dataTransfer.types.includes('application/x-tgg-path') || e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => void dropOn(e, ws.root!)}>
        {filter ? (filtered.length ? filtered.map(f => (
          <div key={f.rel} className="tree-row" style={{ paddingLeft: 12 }} onClick={() => void useEditor.getState().openFile(joinPath(ws.root!, f.rel), { pin: true })}>
            <FileIcon name={basename(f.rel)} size={16} /><span className="truncate"><Highlight text={f.rel} indices={f.indices} /></span>
          </div>)) : <div className="subtle" style={{ padding: 16, textAlign: 'center' }}>No files match "{filter}"</div>)
          : renderDir(ws.root, 0)}
      </div>
    </>
  )
}

function useRecent() { const [r, setR] = useState<string[]>([]); useEffect(() => { void api.settings.get().then(s => setR(s.ui.recentProjects.slice(0, 6))) }, []); return r }

function EditRow({ depth, kind, initial, isDir, onDone }: { depth: number; kind: 'rename' | 'file' | 'dir'; initial: string; isDir?: boolean; onDone(v: string | null): void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { const el = ref.current!; el.focus(); const dot = initial.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 && kind === 'rename' ? dot : initial.length) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const isFolder = kind === 'dir' || isDir
  return (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span style={{ width: 13 }} /><FileIcon name={v || 'x'} dir={isFolder} size={16} />
      <input ref={ref} className="tree-input" value={v} placeholder={kind === 'dir' ? 'folder name' : 'file name'} onChange={e => setV(e.target.value)} onBlur={() => onDone(v)} onKeyDown={e => { if (e.key === 'Enter') onDone(v); if (e.key === 'Escape') onDone(null); e.stopPropagation() }} />
    </div>
  )
}
