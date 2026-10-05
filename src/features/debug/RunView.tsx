import { useCallback, useEffect, useState } from 'react'
import { Bug, ChevronRight, CirclePlay, Cloud, FlaskConical, Hammer, Package, Pause, Play, Plus, RefreshCw, Rocket, RotateCcw, Square, StepForward, ArrowDownToLine, ArrowUpFromLine, Trash2, Wrench, SlidersHorizontal } from 'lucide-react'
import type { DebugVariable, ProjectInfo, ProjectScript } from '@shared/dev'
import { api } from '../../lib/api'
import { basename, cn } from '../../lib/util'
import { Badge, Button, Collapsible, EmptyState, IconButton, Segmented, Spinner } from '../../components/ui'
import { useDebug } from '../../stores/debug'
import { useEditor } from '../../stores/editor'
import { useTerminals } from '../../stores/terminal'
import { useWorkspace } from '../../stores/workspace'
import { dialogs, toast } from '../../stores/ui'
import { runCommand } from '../../lib/commands'

// ───────────── variables tree ─────────────
function VarNode({ v, depth }: { v: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<DebugVariable[] | null>(null)
  const toggle = async () => { if (!v.expandable || !v.ref) return; if (!open && !kids) setKids(await api.debug.variables(v.ref).catch(() => [])); setOpen(!open) }
  return <>
    <div className="var-row" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => void toggle()}>
      {v.expandable ? <ChevronRight size={12} className={cn('tree-chev', open && 'open')} /> : <span style={{ width: 12 }} />}
      <span className="var-name">{v.name}</span><span className="var-val truncate selectable" data-tip={v.value}>{v.value}</span>{v.type && <span className="var-type">{v.type}</span>}
    </div>
    {open && kids?.map((k, i) => <VarNode key={k.name + i} v={k} depth={depth + 1} />)}
  </>
}

function Scope({ name, refId }: { name: string; refId: string }) {
  const [vars, setVars] = useState<DebugVariable[] | null>(null)
  useEffect(() => { setVars(null); void api.debug.variables(refId).then(setVars).catch(() => setVars([])) }, [refId])
  return <Collapsible title={name} storageKey={'dbg-scope-' + name} count={vars?.length}>{vars === null ? <div className="center" style={{ padding: 8 }}><Spinner size={12} /></div> : vars.length === 0 ? <div className="subtle small" style={{ padding: '2px 18px 6px' }}>Empty</div> : vars.map((v, i) => <VarNode key={v.name + i} v={v} depth={0} />)}</Collapsible>
}

function Watches() {
  const watches = useDebug(s => s.watches)
  const frameId = useDebug(s => s.frameId)
  const state = useDebug(s => s.snapshot.state)
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => {
    if (state !== 'paused') return
    let dead = false
    void Promise.all(watches.map(async w => [w, await api.debug.evaluate(w, frameId ?? undefined).then(r => r.value).catch(e => `⚠ ${(e as Error).message}`)] as const)).then(r => { if (!dead) setVals(Object.fromEntries(r)) })
    return () => { dead = true }
  }, [watches, frameId, state])
  return <Collapsible title="Watch" count={watches.length} storageKey="dbg-watch" actions={<IconButton icon={Plus} size="sm" tip="Add expression" onClick={async () => { const e = await dialogs.prompt({ title: 'Watch expression', placeholder: 'user.name' }); if (e?.trim()) useDebug.getState().setWatches([...watches, e.trim()]) }} />}>
    {watches.length === 0 && <div className="subtle small" style={{ padding: '2px 18px 6px' }}>Add an expression to track while stepping.</div>}
    {watches.map(w => <div key={w} className="var-row" style={{ paddingLeft: 18 }}><span className="var-name">{w}</span><span className="var-val truncate">{state === 'paused' ? vals[w] ?? '…' : <span className="subtle">not paused</span>}</span><IconButton icon={Trash2} size="sm" tip="Remove" onClick={() => useDebug.getState().setWatches(watches.filter(x => x !== w))} /></div>)}
  </Collapsible>
}

// ───────────── debugger panel ─────────────
function DebugControls() {
  const snap = useDebug(s => s.snapshot)
  const frameId = useDebug(s => s.frameId)
  const bps = useDebug(s => s.breakpoints)
  const exc = useDebug(s => s.exceptionMode)
  const active = snap.state !== 'inactive' && snap.state !== 'terminated'
  const frame = snap.frames.find(f => f.id === frameId) ?? snap.frames[0]
  const list = Object.values(bps).flat().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return <>
    {active && <div className="dbg-bar">
      <IconButton icon={snap.state === 'paused' ? Play : Pause} tip={snap.state === 'paused' ? 'Continue (F5)' : 'Pause'} onClick={() => (snap.state === 'paused' ? runCommand('debug.continue') : void api.debug.pause())} />
      <IconButton icon={StepForward} tip="Step over (F10)" disabled={snap.state !== 'paused'} onClick={() => runCommand('debug.stepOver')} />
      <IconButton icon={ArrowDownToLine} tip="Step into (F11)" disabled={snap.state !== 'paused'} onClick={() => runCommand('debug.stepInto')} />
      <IconButton icon={ArrowUpFromLine} tip="Step out (Shift+F11)" disabled={snap.state !== 'paused'} onClick={() => runCommand('debug.stepOut')} />
      <IconButton icon={RotateCcw} tip="Restart" onClick={() => runCommand('debug.restart')} />
      <IconButton icon={Square} tip="Stop (Shift+F5)" className="stop" onClick={() => runCommand('debug.stop')} />
      <span className="grow" /><Badge kind={snap.state === 'paused' ? 'warning' : 'success'}>{snap.state === 'paused' ? `Paused${snap.pauseReason ? ` · ${snap.pauseReason}` : ''}` : snap.state === 'starting' ? 'Starting…' : 'Running'}</Badge>
    </div>}
    {snap.exception && <div className="scm-banner err" style={{ marginTop: 8 }}><span className="grow selectable">{snap.exception}</span></div>}
    {active && snap.state === 'paused' && frame && <>
      {frame.scopes.map(s => <Scope key={s.ref} name={s.name} refId={s.ref} />)}
      <Watches />
      <Collapsible title="Call stack" count={snap.frames.length} storageKey="dbg-stack">{snap.frames.map(f => <div key={f.id} className={cn('scm-row', f.id === (frameId ?? snap.frames[0]?.id) && 'cur')} onClick={() => { useDebug.getState().selectFrame(f.id); void useEditor.getState().openFile(f.path, { line: f.line, col: f.col, pin: true }) }}><span className="scm-name truncate">{f.name || '(anonymous)'}</span><span className="scm-dir truncate">{basename(f.path)}:{f.line}</span></div>)}</Collapsible>
    </>}
    {active && snap.state !== 'paused' && <Watches />}
    <Collapsible title="Breakpoints" count={list.length} storageKey="dbg-bps" actions={list.length > 0 ? <IconButton icon={Trash2} size="sm" tip="Remove all breakpoints" onClick={() => void useDebug.getState().clearBreakpoints()} /> : undefined}>
      {list.length === 0 && <div className="subtle small" style={{ padding: '2px 18px 6px' }}>Click in the gutter next to a line number to set a breakpoint.</div>}
      {list.map(b => <div key={b.path + b.line} className="scm-row" onClick={() => void useEditor.getState().openFile(b.path, { line: b.line, pin: true })}>
        <input type="checkbox" checked={b.enabled} onClick={e => e.stopPropagation()} onChange={e => void useDebug.getState().editBreakpoint(b.path, b.line, { enabled: e.target.checked })} aria-label="Enabled" />
        <span className="scm-name truncate">{basename(b.path)}</span><span className="scm-dir truncate">:{b.line}{b.condition ? ` if ${b.condition}` : ''}{b.logMessage ? ` log “${b.logMessage}”` : ''}</span>
        <span className="scm-acts"><IconButton icon={SlidersHorizontal} size="sm" tip="Condition…" onClick={async e => { e.stopPropagation(); const c = await dialogs.prompt({ title: 'Breakpoint condition', message: 'Only pause when this expression is true. Leave empty to always pause.', initial: b.condition ?? '', placeholder: 'i > 10' }); if (c !== null) void useDebug.getState().editBreakpoint(b.path, b.line, { condition: c.trim() || undefined }) }} /><IconButton icon={Trash2} size="sm" tip="Remove" onClick={e => { e.stopPropagation(); void useDebug.getState().removeBreakpoint(b.path, b.line) }} /></span></div>)}
      <div style={{ padding: '6px 14px 8px' }}><div className="field-label" style={{ marginBottom: 4, fontSize: 11 }}>Pause on exceptions</div><Segmented<'none' | 'uncaught' | 'all'> value={exc} options={[{ value: 'none', label: 'Never' }, { value: 'uncaught', label: 'Uncaught' }, { value: 'all', label: 'All' }]} onChange={m => { useDebug.setState({ exceptionMode: m }); void api.debug.setExceptionBreakpoints(m) }} /></div>
    </Collapsible>
  </>
}

// ───────────── project: scripts, tests, dependencies, deploy ─────────────
const KIND_ICON = { test: FlaskConical, build: Hammer, dev: Rocket, lint: Wrench, script: CirclePlay, other: CirclePlay } as const

function Project() {
  const root = useWorkspace(s => s.root)
  const [info, setInfo] = useState<ProjectInfo | null | undefined>(undefined)
  const [outdated, setOutdated] = useState<{ name: string; current: string; wanted: string; latest: string }[] | null>(null)
  const [checking, setChecking] = useState(false)
  const load = useCallback(() => void api.project.info().then(setInfo).catch(() => setInfo(null)), [])
  useEffect(() => { load() }, [load, root])
  const run = (s: ProjectScript) => void useTerminals.getState().runCommand(s.command, s.name)
  if (info === undefined) return <div className="center" style={{ padding: 20 }}><Spinner /></div>
  if (!info) return <div className="subtle small" style={{ padding: '8px 16px' }}>Open a project to see its scripts and dependencies.</div>
  const addDep = async (dev: boolean) => { const n = await dialogs.prompt({ title: dev ? 'Add a development dependency' : 'Add a dependency', placeholder: 'package name', confirmLabel: 'Install' }); if (n?.trim()) void useTerminals.getState().runCommand(await api.project.installCommand(n.trim(), dev), `install ${n.trim()}`) }
  const removeDep = async (name: string) => { if (await dialogs.confirm({ title: `Uninstall ${name}?`, confirmLabel: 'Uninstall', danger: true })) void useTerminals.getState().runCommand(await api.project.installCommand(name, false, true), `remove ${name}`) }
  const check = async () => { setChecking(true); try { setOutdated(await api.project.outdated()) } catch (e) { toast.error((e as Error).message) } finally { setChecking(false) } }
  const out = new Map((outdated ?? []).map(o => [o.name, o]))
  return <>
    <div className="proj-badges">{info.languages.map(l => <Badge key={l}>{l}</Badge>)}{info.frameworks.map(l => <Badge key={l} kind="accent">{l}</Badge>)}{info.packageManager !== 'none' && <Badge kind="info">{info.packageManager}</Badge>}</div>
    {info.testCommand && <div style={{ padding: '2px 12px 8px' }}><Button icon={FlaskConical} style={{ width: '100%' }} onClick={() => void useTerminals.getState().runCommand(info.testCommand!, 'tests')}>Run tests{info.testFramework ? ` (${info.testFramework})` : ''}</Button></div>}
    <Collapsible title="Scripts & tasks" count={info.scripts.length} storageKey="proj-scripts">
      {info.scripts.length === 0 && <div className="subtle small" style={{ padding: '2px 18px 6px' }}>No scripts found.</div>}
      {info.scripts.map(s => { const I = KIND_ICON[s.kind] ?? CirclePlay; return <div key={s.source + s.name} className="scm-row" onClick={() => run(s)} data-tip={s.command}><I size={14} className="accent-ic" /><span className="scm-name truncate">{s.name}</span><span className="scm-dir truncate">{s.command}</span><span className="scm-acts"><Play size={13} /></span></div> })}
    </Collapsible>
    <Collapsible title="Dependencies" count={info.dependencies.length} storageKey="proj-deps" defaultOpen={false} actions={<><IconButton icon={RefreshCw} className={checking ? 'spin-anim' : ''} size="sm" tip="Check for updates" onClick={() => void check()} /><IconButton icon={Plus} size="sm" tip="Add dependency" onClick={() => void addDep(false)} /></>}>
      {info.dependencies.map(d => { const o = out.get(d.name); return <div key={d.name} className="scm-row" style={{ cursor: 'default' }}><Package size={13} className="subtle" /><span className="scm-name truncate">{d.name}</span><span className="scm-dir truncate">{d.version}{d.dev ? ' · dev' : ''}</span>{o && <Badge kind="warning" title={`latest ${o.latest}`}>{o.latest}</Badge>}<span className="scm-acts"><IconButton icon={Trash2} size="sm" tip="Uninstall" onClick={() => void removeDep(d.name)} /></span></div> })}
      <div style={{ padding: '4px 14px' }}><button className="link-btn small" onClick={() => void addDep(true)}>+ Add dev dependency</button></div>
    </Collapsible>
    {info.deploy.length > 0 && <Collapsible title="Deploy" count={info.deploy.length} storageKey="proj-deploy" defaultOpen={false}>
      {info.deploy.map(d => <div key={d.id} className="ext-card plain" style={{ cursor: 'default' }}><span className="ext-ic"><Cloud size={16} /></span><div className="ext-main"><b>{d.label}</b><div className="ext-desc">{d.description}</div></div>{d.command ? <Button size="sm" variant="secondary" onClick={() => void useTerminals.getState().runCommand(d.command!, d.label)}>Run</Button> : <Button size="sm" variant="ghost" onClick={() => void useEditor.getState().openFile(root + '/' + d.file, { pin: true })}>Open</Button>}</div>)}
    </Collapsible>}
  </>
}

// ───────────── view ─────────────
export function RunView() {
  const root = useWorkspace(s => s.root)
  const configs = useDebug(s => s.configs)
  const selected = useDebug(s => s.selectedConfig)
  const snap = useDebug(s => s.snapshot)
  const [tab, setTab] = useState<'debug' | 'project'>('debug')
  useEffect(() => { void useDebug.getState().loadConfigs() }, [root])
  const active = snap.state !== 'inactive' && snap.state !== 'terminated'
  const editConfigs = async () => {
    await dialogs.custom({ title: 'Launch configurations', wide: true, render: close => <ConfigEditor close={close} /> })
    void useDebug.getState().loadConfigs()
  }
  if (!root) return <><div className="sb-head"><h2>Run & Debug</h2></div><EmptyState icon={Bug} title="No folder open" text="Open a project to run scripts and debug Node.js programs." /></>
  return <>
    <div className="sb-head"><h2>Run & Debug</h2></div>
    <div className="run-top">
      <div className="row gap6">
        <select className="select sm grow" value={selected} onChange={e => useDebug.setState({ selectedConfig: e.target.value })} aria-label="Launch configuration">{configs.map(c => <option key={c.name}>{c.name}</option>)}</select>
        <IconButton icon={SlidersHorizontal} size="sm" tip="Edit launch configurations" onClick={() => void editConfigs()} />
      </div>
      <div className="row gap6" style={{ marginTop: 8 }}>
        <Button variant="primary" icon={Bug} style={{ flex: 1 }} disabled={active} onClick={() => runCommand('debug.start')}>Debug</Button>
        <Button icon={Play} style={{ flex: 1 }} disabled={active} onClick={() => runCommand('debug.run')}>Run</Button>
      </div>
      <div className="subtle tiny" style={{ marginTop: 6 }}>Debugging supports Node.js and JavaScript/TypeScript on Node. <kbd className="kbd">F5</kbd> starts, <kbd className="kbd">F9</kbd> toggles a breakpoint.</div>
    </div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><Segmented<'debug' | 'project'> value={tab} options={[{ value: 'debug', label: 'Debug' }, { value: 'project', label: 'Project' }]} onChange={setTab} /></div>
    <div className="sb-body" style={{ paddingBottom: 20 }}>{tab === 'debug' ? <DebugControls /> : <Project />}</div>
  </>
}

function ConfigEditor({ close }: { close(v?: unknown): void }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void api.debug.loadConfigs().then(c => setText(JSON.stringify(c, null, 2))) }, [])
  const save = async () => { try { const v = JSON.parse(text); if (!Array.isArray(v)) throw new Error('Expected a list of configurations.'); await api.debug.saveConfigs(v); close(true) } catch (e) { setErr((e as Error).message) } }
  return <div className="col gap12"><p style={{ margin: 0, fontSize: 13 }}>Each configuration has a <code>name</code>, a <code>type</code> (<code>node</code> or <code>node-attach</code>), a <code>program</code> (use <code>{'${file}'}</code> for the open file), optional <code>args</code>, <code>cwd</code> and <code>env</code>.</p>
    <textarea className="textarea mono" rows={16} value={text} onChange={e => { setText(e.target.value); setErr(null) }} style={{ fontSize: 12 }} spellCheck={false} />
    {err && <div className="msg-error"><span>{err}</span></div>}
    <div className="row gap8" style={{ justifyContent: 'flex-end' }}><Button variant="ghost" onClick={() => close()}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></div></div>
}
