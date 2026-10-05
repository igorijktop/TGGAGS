import { useEffect, useMemo, useRef, useState } from 'react'
import { kbHint } from '../../lib/commands'
import { AlertCircle, AlertTriangle, Bug, ChevronDown, Info, Maximize2, Minimize2, Plus, Sparkles, SquareTerminal, Trash2, X, CircleCheck, Terminal as TermIcon } from 'lucide-react'
import type { LogLine } from '@shared/api'
import type { LspDiagnostic } from '@shared/dev'
import { api, onEvent } from '../../lib/api'
import { cn, relativeTo, basename } from '../../lib/util'
import { Button, EmptyState, IconButton, Menu, Segmented } from '../../components/ui'
import { useUi, type PanelTab } from '../../stores/ui'
import { useTerminals } from '../../stores/terminal'
import { useDebug } from '../../stores/debug'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'
import { useAi } from '../../stores/ai'
import { useDiagnostics } from '../../lib/lsp-monaco'
import { FileIcon } from '../../lib/icons'
import { TerminalView } from './TerminalView'

// ───────────── terminals ─────────────
function Terminals() {
  const terms = useTerminals(s => s.terminals)
  const active = useTerminals(s => s.active)
  const focusKey = useUi(s => s.panelTab) // re-fit when switching back
  useEffect(() => { if (terms.length === 0) void useTerminals.getState().ensure() }, [terms.length])
  return <div className="term-wrap">
    {terms.map(t => <TerminalView key={t.id} id={t.id} visible={t.id === active} focusKey={focusKey === 'terminal' ? 1 : 0} />)}
    {terms.length === 0 && <div className="center grow subtle">Starting terminal…</div>}
  </div>
}

function TerminalChips() {
  const terms = useTerminals(s => s.terminals)
  const active = useTerminals(s => s.active)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  if (terms.length === 0) return null
  const cur = terms.find(t => t.id === active) ?? terms[0]
  return <>
    <button className="term-chip" onClick={e => setMenu(menu ? null : e.currentTarget)}><SquareTerminal size={13} /><span className="truncate">{cur.name}</span>{cur.exited !== undefined && cur.exited !== null && <span className="subtle">(exited)</span>}{terms.length > 1 && <><span className="badge">{terms.length}</span><ChevronDown size={12} /></>}</button>
    {menu && <Menu anchor={menu} onClose={() => setMenu(null)} items={terms.map(t => ({ label: t.name, checked: t.id === active, hint: t.shell, onClick: () => useTerminals.getState().select(t.id) }))} />}
    <IconButton icon={Plus} size="sm" tip="New terminal" kbd={kbHint('terminal.new')} onClick={() => void useTerminals.getState().create()} />
    <IconButton icon={Trash2} size="sm" tip="Kill this terminal" onClick={() => void useTerminals.getState().kill(cur.id)} />
  </>
}

// ───────────── problems ─────────────
type Sev = 'all' | 'error' | 'warning'
function Problems() {
  const byPath = useDiagnostics(s => s.byPath)
  const root = useWorkspace(s => s.root)
  const [filter, setFilter] = useState<Sev>('all')
  const groups = useMemo(() => Object.entries(byPath).map(([path, list]) => ({ path, list: list.filter(d => d.severity !== 'hint' && (filter === 'all' || d.severity === filter)).sort((a, b) => a.line - b.line) })).filter(g => g.list.length).sort((a, b) => a.path.localeCompare(b.path)), [byPath, filter])
  const total = groups.reduce((n, g) => n + g.list.length, 0)
  const fixWithAi = (path: string, d: LspDiagnostic) => { useUi.getState().set({ aiVisible: true }); void useAi.getState().send(`Fix this problem in ${relativeTo(root, path)}:${d.line}: ${d.message.split('\n')[0]}`) }
  const fixAll = () => { const lines = groups.flatMap(g => g.list.filter(d => d.severity === 'error').map(d => `${relativeTo(root, g.path)}:${d.line} ${d.message.split('\n')[0]}`)).slice(0, 60); if (!lines.length) return; useUi.getState().set({ aiVisible: true }); void useAi.getState().send(`Fix these errors:\n${lines.join('\n')}`) }
  return <div className="col grow" style={{ minHeight: 0 }}>
    <div className="panel-sub"><Segmented<Sev> value={filter} options={[{ value: 'all', label: 'All' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }]} onChange={setFilter} /><span className="grow" /><Button size="sm" variant="soft" icon={Sparkles} disabled={!groups.some(g => g.list.some(d => d.severity === 'error'))} onClick={fixAll}>Fix errors with AI</Button></div>
    <div className="panel-scroll">
      {total === 0 ? <EmptyState icon={CircleCheck} title="No problems" text="Errors and warnings from the language servers show up here for the files you have opened." /> : groups.map(g => <div key={g.path}>
        <div className="prob-file"><FileIcon name={basename(g.path)} size={14} /><b>{basename(g.path)}</b><span className="subtle truncate">{relativeTo(root, g.path)}</span><span className="badge">{g.list.length}</span></div>
        {g.list.map((d, i) => <div key={i} className="prob-row" onClick={() => void useEditor.getState().openFile(g.path, { line: d.line, col: d.col, pin: true })}>
          {d.severity === 'error' ? <AlertCircle size={14} className="err" /> : d.severity === 'warning' ? <AlertTriangle size={14} className="warn" /> : <Info size={14} className="info-ic" />}
          <span className="prob-msg">{d.message.split('\n')[0]}</span>{d.source && <span className="subtle small">{d.source}{d.code !== undefined ? `(${d.code})` : ''}</span>}<span className="subtle small">[{d.line}, {d.col}]</span>
          <button className="prob-fix" onClick={e => { e.stopPropagation(); fixWithAi(g.path, d) }} data-tip="Ask the AI to fix this"><Sparkles size={13} /></button>
        </div>)}
      </div>)}
    </div>
  </div>
}

// ───────────── output ─────────────
function Output() {
  const [channels, setChannels] = useState<string[]>([])
  const [ch, setCh] = useState('')
  const [lines, setLines] = useState<LogLine[]>([])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { void api.output.channels().then(c => { setChannels(c); setCh(x => x || c[0] || '') }); }, [])
  useEffect(() => { if (!ch) return; void api.output.get(ch).then(setLines) }, [ch])
  useEffect(() => {
    const a = onEvent('output:line', l => { setChannels(c => (c.includes(l.channel) ? c : [...c, l.channel])); setCh(x => x || l.channel); setLines(x => (l.channel === ch ? [...x, l].slice(-3000) : x)) })
    const b = onEvent('output:cleared', c => { if (c === ch) setLines([]) })
    return () => { a(); b() }
  }, [ch])
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight }, [lines.length, ch])
  return <div className="col grow" style={{ minHeight: 0 }}>
    <div className="panel-sub"><select className="select sm" style={{ width: 180 }} value={ch} onChange={e => setCh(e.target.value)}>{channels.map(c => <option key={c}>{c}</option>)}</select><span className="grow" /><IconButton icon={Trash2} size="sm" tip="Clear output" onClick={() => void api.output.clear(ch)} /></div>
    <div className="panel-scroll mono-lines selectable" ref={box}>{lines.length === 0 ? <div className="subtle" style={{ padding: 16 }}>Nothing logged here yet.</div> : lines.map((l, i) => <div key={i} className={cn('ol', l.level)}><span className="ol-t">{new Date(l.ts).toLocaleTimeString()}</span>{l.text}</div>)}</div>
  </div>
}

// ───────────── debug console ─────────────
function DebugConsole() {
  const lines = useDebug(s => s.console)
  const frameId = useDebug(s => s.frameId)
  const state = useDebug(s => s.snapshot.state)
  const [input, setInput] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight }, [lines.length])
  const run = async () => {
    const e = input.trim(); if (!e) return
    setInput(''); useDebug.getState().addLine('input', e)
    try { const r = await api.debug.evaluate(e, frameId ?? undefined); useDebug.getState().addLine(r.error ? 'error' : 'result', r.value) } catch (err) { useDebug.getState().addLine('error', (err as Error).message) }
  }
  return <div className="col grow" style={{ minHeight: 0 }}>
    <div className="panel-scroll mono-lines selectable" ref={box}>{lines.length === 0 ? <div className="subtle" style={{ padding: 16 }}>Start a debug session with F5 to see program output here. While paused you can evaluate expressions below.</div> : lines.map(l => <div key={l.id} className={cn('ol', l.kind)}>{l.kind === 'input' && <span className="subtle">› </span>}{l.text}</div>)}</div>
    <div className="dbg-input"><span className="subtle">›</span><input value={input} disabled={state !== 'paused'} placeholder={state === 'paused' ? 'Evaluate an expression…' : 'Available while paused at a breakpoint'} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run() }} /></div>
  </div>
}

// ───────────── panel ─────────────
export function BottomPanel() {
  const ui = useUi()
  const errors = useDiagnostics(s => s.errors), warnings = useDiagnostics(s => s.warnings)
  const dbg = useDebug(s => s.snapshot.state)
  const tabs: { id: PanelTab; label: string; icon: typeof Bug; badge?: number; tone?: string }[] = [
    { id: 'terminal', label: 'Terminal', icon: TermIcon }, { id: 'problems', label: 'Problems', icon: AlertCircle, badge: errors + warnings, tone: errors ? 'danger' : 'warning' },
    { id: 'output', label: 'Output', icon: Info }, { id: 'debug', label: 'Debug console', icon: Bug, badge: dbg === 'paused' ? 1 : undefined, tone: 'warning' }
  ]
  return <div className={cn('panel', ui.panelMaximized && 'maximized')} style={ui.panelMaximized ? undefined : { height: ui.panelHeight }} aria-label="Panel">
    <div className="panel-head">
      {tabs.map(t => <button key={t.id} className={cn('panel-tab', ui.panelTab === t.id && 'on')} onClick={() => ui.set({ panelTab: t.id })}>{t.label}{!!t.badge && <span className={cn('badge', t.tone)}>{t.badge}</span>}</button>)}
      <span className="panel-sep" />
      {ui.panelTab === 'terminal' && <TerminalChips />}
      <span className="grow" />
      <IconButton icon={ui.panelMaximized ? Minimize2 : Maximize2} size="sm" tip={ui.panelMaximized ? 'Restore panel size' : 'Maximize panel'} onClick={() => ui.set({ panelMaximized: !ui.panelMaximized })} />
      <IconButton icon={X} size="sm" tip="Close panel" onClick={() => ui.set({ panelVisible: false, panelMaximized: false })} />
    </div>
    <div className="panel-body">
      <div className="col grow" style={{ display: ui.panelTab === 'terminal' ? 'flex' : 'none', minHeight: 0 }}><Terminals /></div>
      {ui.panelTab === 'problems' && <Problems />}
      {ui.panelTab === 'output' && <Output />}
      {ui.panelTab === 'debug' && <DebugConsole />}
    </div>
  </div>
}
