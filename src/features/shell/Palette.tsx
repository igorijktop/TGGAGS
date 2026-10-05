import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { CornerDownLeft, Search, FileText } from 'lucide-react'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { useEditor } from '../../stores/editor'
import { allCommands, formatKeybinding, keybindingFor, runCommand } from '../../lib/commands'
import { api } from '../../lib/api'
import { basename, fuzzy, joinPath, cn, relativeTo, debounce } from '../../lib/util'
import { FileIcon } from '../../lib/icons'
import { Highlight } from '../../components/ui'
import { activeMonacoEditor } from '../../lib/editor-context'
import type { LspSymbol } from '@shared/dev'

export interface PickItem<T = unknown> { label: string; description?: string; detail?: string; value: T; icon?: ReactNode; hint?: string; separator?: string }
interface PickerState { picker: null | { title?: string; placeholder?: string; items: PickItem[]; resolve(v: unknown): void; allowCustom?: boolean } }
const usePicker = create<PickerState>(() => ({ picker: null }))

/** Promise-based quick-pick list (branch chooser, model chooser, …). Resolves with the chosen value or undefined. */
export function pick<T>(o: { title?: string; placeholder?: string; items: PickItem<T>[]; allowCustom?: boolean }): Promise<T | undefined> {
  return new Promise(resolve => usePicker.setState({ picker: { ...o, resolve: resolve as (v: unknown) => void } }))
}

interface Row { id: string; label: string; detail?: string; hint?: string; icon?: ReactNode; indices: number[]; run(): void; section?: string }

export function Palette() {
  const { open, value: initial } = useUi(s => s.palette)
  const close = useUi(s => s.closePalette)
  const picker = usePicker(s => s.picker)
  const [value, setValue] = useState('')
  const [index, setIndex] = useState(0)
  const [rows, setRows] = useState<Row[]>([])
  const ws = useWorkspace()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const visible = open || !!picker

  useEffect(() => { if (visible) { setValue(picker ? '' : initial ?? ''); setIndex(0); setTimeout(() => input.current?.focus(), 0) } }, [visible, initial, picker])

  const mode = picker ? 'pick' : value.startsWith('>') ? 'cmd' : value.startsWith('@') ? 'sym' : value.startsWith('#') ? 'wsym' : value.startsWith(':') ? 'line' : 'file'
  const query = mode === 'pick' || mode === 'file' ? value : value.slice(1)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const set = (r: Row[]) => { if (!cancelled) { setRows(r); setIndex(0) } }
    const run = debounce(async () => {
      if (mode === 'pick') {
        const items = picker!.items.map((it, i) => ({ it, m: fuzzy(query.trim(), `${it.label} ${it.description ?? ''}`) })).filter(x => x.m).sort((a, b) => (query ? b.m!.score - a.m!.score : 0))
        const out: Row[] = items.map(({ it, m }, i) => ({ id: String(i), label: it.label, detail: it.description ?? it.detail, hint: it.hint, icon: it.icon, indices: m!.indices.filter(x => x < it.label.length), run: () => { picker!.resolve(it.value); usePicker.setState({ picker: null }) }, section: it.separator }))
        if (picker!.allowCustom && query.trim() && !out.some(r => r.label === query.trim())) out.unshift({ id: 'custom', label: query.trim(), detail: 'Use this value', indices: [], run: () => { picker!.resolve(query.trim()); usePicker.setState({ picker: null }) } })
        set(out)
      } else if (mode === 'cmd') {
        const r = allCommands().filter(c => !c.hidden && (!c.enabled || c.enabled())).map(c => ({ c, m: fuzzy(query.trim(), `${c.category ? c.category + ': ' : ''}${c.title}`) })).filter(x => x.m).sort((a, b) => b.m!.score - a.m!.score).slice(0, 80)
        set(r.map(({ c, m }) => ({ id: c.id, label: `${c.category ? c.category + ': ' : ''}${c.title}`, hint: keybindingFor(c.id) ? formatKeybinding(keybindingFor(c.id)!) : undefined, indices: m!.indices, run: () => { close(); void runCommand(c.id) } })))
      } else if (mode === 'line') {
        const n = parseInt(query, 10)
        set(Number.isFinite(n) ? [{ id: 'line', label: `Go to line ${n}`, indices: [], run: () => { close(); const ed = activeMonacoEditor(); ed?.revealLineInCenter(n); ed?.setPosition({ lineNumber: n, column: 1 }); ed?.focus() } }] : [{ id: 'hint', label: 'Type a line number to go to', indices: [], run: () => undefined }])
      } else if (mode === 'sym') {
        const tab = useEditor.getState().activeTab()
        if (!tab?.path) { set([{ id: 'none', label: 'Open a file to see its symbols', indices: [], run: () => undefined }]); return }
        const syms = await api.lsp.documentSymbols(tab.path).catch(() => [] as LspSymbol[])
        const flat: LspSymbol[] = []; const walk = (l: LspSymbol[], d = 0) => l.forEach(s => { flat.push({ ...s, containerName: s.containerName ?? (d ? '…' : undefined) }); if (s.children) walk(s.children, d + 1) }); walk(syms)
        set(flat.map(s => ({ s, m: fuzzy(query.trim(), s.name) })).filter(x => x.m).sort((a, b) => (query ? b.m!.score - a.m!.score : a.s.line - b.s.line)).slice(0, 100).map(({ s, m }) => ({ id: `${s.name}:${s.line}`, label: s.name, detail: `${s.kind} · line ${s.line}`, indices: m!.indices, run: () => { close(); const ed = activeMonacoEditor(); ed?.revealLineInCenter(s.line); ed?.setPosition({ lineNumber: s.line, column: s.col }); ed?.focus() } })))
      } else if (mode === 'wsym') {
        if (!query.trim()) { set([{ id: 'hint', label: 'Type to search symbols across the project', indices: [], run: () => undefined }]); return }
        const syms = await api.lsp.workspaceSymbols(query.trim()).catch(() => [] as LspSymbol[])
        set(syms.slice(0, 80).map(s => ({ id: `${s.path}:${s.name}:${s.line}`, label: s.name, detail: `${s.kind}${s.containerName ? ' · ' + s.containerName : ''} — ${relativeTo(ws.root, s.path ?? '')}:${s.line}`, indices: [], icon: <FileIcon name={basename(s.path ?? 'x')} size={15} />, run: () => { close(); void useEditor.getState().openFile(s.path!, { line: s.line, col: s.col, pin: true }) } })))
      } else {
        // files (optionally "name:line")
        const m = query.match(/^(.*?)(?::(\d+))?$/)
        const q = (m?.[1] ?? '').trim(); const line = m?.[2] ? Number(m[2]) : undefined
        const files = ws.root ? await ws.fileList() : []
        const openTabs = Object.values(useEditor.getState().groups).flatMap(g => g.tabs.filter(t => t.kind === 'file' && t.path).map(t => relativeTo(ws.root, t.path!)))
        const scored = (q ? files.map(f => ({ f, m: fuzzy(q, f) })).filter(x => x.m).sort((a, b) => b.m!.score - a.m!.score) : [...new Set([...openTabs, ...files])].map(f => ({ f, m: { score: 0, indices: [] as number[] } }))).slice(0, 100)
        set(scored.map(({ f, m }) => ({ id: f, label: basename(f), detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : undefined, indices: (m?.indices ?? []).map(i => i - (f.lastIndexOf('/') + 1)).filter(i => i >= 0), icon: <FileIcon name={basename(f)} size={16} />, run: () => { close(); void useEditor.getState().openFile(joinPath(ws.root!, f), { line, pin: true }) } })))
      }
    }, mode === 'wsym' ? 160 : 20)
    void run()
    return () => { cancelled = true; run.cancel() }
  }, [visible, mode, query, picker, ws.root]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { list.current?.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' }) }, [index, rows])

  const dismiss = () => { if (picker) { picker.resolve(undefined); usePicker.setState({ picker: null }) } else close() }
  const placeholder = picker?.placeholder ?? (mode === 'cmd' ? 'Type a command…' : mode === 'sym' ? 'Go to symbol in file…' : mode === 'wsym' ? 'Go to symbol in project…' : mode === 'line' ? 'Go to line…' : 'Search files by name — or type > for commands, @ symbols, # project symbols, : line')

  if (!visible) return null
  const rowsToShow = rows
  return createPortal(
    <div className="overlay top" onMouseDown={e => { if (e.target === e.currentTarget) dismiss() }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="pal-input">
          <Search size={16} className="subtle" />
          <input ref={input} value={value} placeholder={placeholder} spellCheck={false}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); dismiss() }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(rowsToShow.length - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); rowsToShow[index]?.run() }
              else if (e.key === 'Backspace' && !value && !picker && mode !== 'file') setValue('')
            }} />
          {picker?.title && <span className="badge accent">{picker.title}</span>}
        </div>
        <div className="pal-list" ref={list}>
          {rowsToShow.length === 0 && <div className="pal-empty">{mode === 'file' && !ws.root ? 'Open a folder to search its files' : 'No results'}</div>}
          {rowsToShow.map((r, i) => (
            <div key={r.id + i}>
              {r.section && (i === 0 || rowsToShow[i - 1].section !== r.section) && <div className="menu-title">{r.section}</div>}
              <div className={cn('pal-row', i === index && 'on')} onMouseMove={() => setIndex(i)} onClick={() => r.run()}>
                {r.icon ?? (mode === 'file' ? <FileText size={15} /> : null)}
                <span className="pal-label truncate"><Highlight text={r.label} indices={r.indices} /></span>
                {r.detail && <span className="pal-detail truncate">{r.detail}</span>}
                {r.hint && <span className="kbd">{r.hint}</span>}
                {i === index && <CornerDownLeft size={13} className="subtle" />}
              </div>
            </div>
          ))}
        </div>
        <div className="pal-foot"><span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span><span><span className="kbd">↵</span> select</span><span><span className="kbd">Esc</span> close</span>{!picker && <span className="grow" style={{ textAlign: 'right' }}>&gt; commands · @ symbols · # project · : line</span>}</div>
      </div>
    </div>, document.body)
}
