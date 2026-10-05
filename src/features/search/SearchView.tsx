import { useCallback, useEffect, useRef, useState } from 'react'
import { CaseSensitive, ChevronRight, Ellipsis, Regex, Replace, ReplaceAll, Search, WholeWord, X, FolderSearch, History } from 'lucide-react'
import type { SearchFileResult, SearchOptions, SearchResult } from '@shared/fs'
import { api } from '../../lib/api'
import { basename, cn, dirname, uid } from '../../lib/util'
import { EmptyState, IconButton, Spinner } from '../../components/ui'
import { FileIcon } from '../../lib/icons'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'
import { dialogs, toast } from '../../stores/ui'
import { activeMonacoEditor } from '../../lib/editor-context'

const HIST_KEY = 'search:history'
const loadHist = (): string[] => { try { return JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]') } catch { return [] } }
const pushHist = (q: string) => { try { const h = [q, ...loadHist().filter(x => x !== q)].slice(0, 30); localStorage.setItem(HIST_KEY, JSON.stringify(h)) } catch { /* ignore */ } }

function Toggle({ on, onClick, icon: Icon, tip }: { on: boolean; onClick(): void; icon: typeof Regex; tip: string }) {
  return <button className={cn('sv-toggle', on && 'on')} onClick={onClick} data-tip={tip} aria-pressed={on} aria-label={tip}><Icon size={14} /></button>
}

export function SearchView() {
  const root = useWorkspace(s => s.root)
  const [q, setQ] = useState('')
  const [rep, setRep] = useState('')
  const [showRep, setShowRep] = useState(false)
  const [details, setDetails] = useState(false)
  const [opts, setOpts] = useState({ isRegex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '', useExcludeSettings: true })
  const [res, setRes] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [histIdx, setHistIdx] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const current = useRef<string | null>(null)

  const build = useCallback((): SearchOptions => ({ query: q, ...opts, maxResults: 3000 }), [q, opts])
  const run = useCallback(async () => {
    if (!q.trim() || !root) { setRes(null); setErr(null); return }
    if (current.current) void api.search.cancel(current.current)
    const id = uid('s-'); current.current = id
    setBusy(true); setErr(null)
    try {
      const r = await api.search.search(build(), id)
      if (current.current === id) { setRes(r); setCollapsed({}) }
    } catch (e) { if (current.current === id) { setErr((e as Error).message.replace(/^Error invoking.*?: /, '')); setRes(null) } }
    finally { if (current.current === id) setBusy(false) }
  }, [q, root, build])

  useEffect(() => { const t = setTimeout(() => void run(), 280); return () => clearTimeout(t) }, [run])
  useEffect(() => {
    const focus = () => {
      const sel = activeMonacoEditor()?.getModel()?.getValueInRange(activeMonacoEditor()!.getSelection()!)
      if (sel && !sel.includes('\n') && sel.length < 200) setQ(sel)
      input.current?.focus(); input.current?.select()
    }
    window.addEventListener('tgg:focus-search', focus)
    input.current?.focus()
    return () => window.removeEventListener('tgg:focus-search', focus)
  }, [])

  const open = (f: SearchFileResult, m?: SearchFileResult['matches'][number]) => { pushHist(q); void useEditor.getState().openFile(f.path, { line: m?.line, col: m?.col, preview: true }) }
  const removeMatch = (path: string, idx: number) => setRes(r => r && ({ ...r, totalMatches: r.totalMatches - 1, files: r.files.map(f => (f.path === path ? { ...f, matches: f.matches.filter((_, i) => i !== idx) } : f)).filter(f => f.matches.length) }))
  const replaceOne = async (f: SearchFileResult, i: number) => {
    const m = f.matches[i]
    const ok = await api.search.replaceOne(f.path, m.line, m.col, m.length, m.text, opts.isRegex ? await regexReplacement(m.text) : rep).catch(() => false)
    if (ok) removeMatch(f.path, i); else { toast.warn('That line changed since the search — searching again.'); void run() }
  }
  // regex replacement for a single match: let the backend apply the pattern to the matched text only
  const regexReplacement = async (matched: string) => { try { const flags = opts.caseSensitive ? '' : 'i'; return matched.replace(new RegExp(opts.wholeWord ? `\\b(?:${q})\\b` : q, flags), rep) } catch { return rep } }
  const replaceAll = async (files?: string[]) => {
    if (!res) return
    const n = files ? res.files.filter(f => files.includes(f.path)).reduce((s, f) => s + f.matches.length, 0) : res.totalMatches
    const nf = files ? files.length : res.files.length
    if (!(await dialogs.confirm({ title: `Replace ${n} occurrence${n === 1 ? '' : 's'} in ${nf} file${nf === 1 ? '' : 's'}?`, message: <>“<b>{q}</b>” will be replaced with “<b>{rep || '(nothing)'}</b>”. Open files with unsaved changes are skipped. You can undo this with Git.</>, confirmLabel: 'Replace', danger: true }))) return
    try { const r = await api.search.replace(build(), rep, files); toast.success(`Replaced ${r.replacements} in ${r.files} file${r.files === 1 ? '' : 's'}.`); pushHist(q); void run() } catch (e) { toast.error((e as Error).message) }
  }
  const onKey = (e: React.KeyboardEvent) => {
    const h = loadHist()
    if (e.key === 'ArrowUp' && !e.shiftKey && (e.altKey || !res || !q)) { e.preventDefault(); const i = Math.min(h.length - 1, histIdx + 1); if (h[i]) { setHistIdx(i); setQ(h[i]) } }
    else if (e.key === 'ArrowDown' && (e.altKey || !q)) { e.preventDefault(); const i = histIdx - 1; setHistIdx(i); setQ(i >= 0 ? h[i] : '') }
    else if (e.key === 'Enter') { pushHist(q); void run() }
    else if (e.key === 'Escape') setQ('')
  }

  const files = res?.files ?? []
  const set = (p: Partial<typeof opts>) => setOpts(o => ({ ...o, ...p }))
  if (!root) return <><div className="sb-head"><h2>Search</h2></div><EmptyState icon={FolderSearch} title="No folder open" text="Open a folder to search across its files." /></>
  return <>
    <div className="sb-head"><h2>Search</h2>
      <IconButton icon={History} size="sm" tip="Previous searches (Alt+↑)" onClick={() => { const h = loadHist(); if (h[0]) { setHistIdx(0); setQ(h[0]) } }} />
      <IconButton icon={ReplaceAll} size="sm" tip="Toggle replace" active={showRep} onClick={() => setShowRep(!showRep)} />
      <IconButton icon={X} size="sm" tip="Clear results" onClick={() => { setQ(''); setRes(null) }} /></div>
    <div className="sv-form">
      <div className="sv-field"><Search size={14} className="sv-ic" /><input ref={input} className="sv-input" placeholder="Find in files" value={q} onChange={e => { setQ(e.target.value); setHistIdx(-1) }} onKeyDown={onKey} spellCheck={false} aria-label="Search" />
        <Toggle on={opts.caseSensitive} icon={CaseSensitive} tip="Match case" onClick={() => set({ caseSensitive: !opts.caseSensitive })} /><Toggle on={opts.wholeWord} icon={WholeWord} tip="Whole word" onClick={() => set({ wholeWord: !opts.wholeWord })} /><Toggle on={opts.isRegex} icon={Regex} tip="Regular expression" onClick={() => set({ isRegex: !opts.isRegex })} /></div>
      {showRep && <div className="sv-field"><Replace size={14} className="sv-ic" /><input className="sv-input" placeholder="Replace with" value={rep} onChange={e => setRep(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && res?.totalMatches) void replaceAll() }} spellCheck={false} aria-label="Replace with" />
        <button className="sv-toggle" disabled={!res?.totalMatches} data-tip="Replace all" onClick={() => void replaceAll()}><ReplaceAll size={14} /></button></div>}
      <button className="sv-details" onClick={() => setDetails(!details)}><Ellipsis size={14} />{details ? 'Hide' : 'Files to include / exclude'}</button>
      {details && <div className="col gap6 fade-in"><input className="input sm" placeholder="Files to include, e.g. src/**, *.ts" value={opts.include} onChange={e => set({ include: e.target.value })} /><input className="input sm" placeholder="Files to exclude, e.g. **/*.test.ts" value={opts.exclude} onChange={e => set({ exclude: e.target.value })} />
        <label className="row gap8 small muted" style={{ cursor: 'pointer' }}><input type="checkbox" checked={opts.useExcludeSettings} onChange={e => set({ useExcludeSettings: e.target.checked })} />Skip node_modules, build output and other ignored files</label></div>}
    </div>
    <div className="sv-status">{busy ? <><Spinner size={12} />Searching…</> : err ? <span className="err">{err}</span> : res ? <span>{res.totalMatches} result{res.totalMatches === 1 ? '' : 's'} in {res.files.length} file{res.files.length === 1 ? '' : 's'}<span className="subtle"> · {res.searchedFiles} searched · {res.durationMs} ms</span>{res.truncated && <span className="warn"> · showing the first {res.totalMatches}</span>}</span> : <span className="subtle">Type to search the whole project.</span>}</div>
    <div className="sb-body sv-results">
      {res && files.length === 0 && !busy && <div className="subtle" style={{ padding: '16px 18px' }}>No results for “{q}”.</div>}
      {files.map(f => <div key={f.path}>
        <div className="sv-file" onClick={() => setCollapsed(c => ({ ...c, [f.path]: !c[f.path] }))}>
          <ChevronRight size={13} className={cn('tree-chev', !collapsed[f.path] && 'open')} /><FileIcon name={basename(f.path)} size={15} /><span className="sv-fname truncate">{basename(f.path)}</span><span className="sv-fdir truncate">{dirname(f.rel)}</span><span className="badge">{f.matches.length}</span>
          <span className="sv-acts">{showRep && <IconButton icon={ReplaceAll} size="sm" tip="Replace all in this file" onClick={e => { e.stopPropagation(); void replaceAll([f.path]) }} />}<IconButton icon={X} size="sm" tip="Dismiss" onClick={e => { e.stopPropagation(); setRes(r => r && ({ ...r, totalMatches: r.totalMatches - f.matches.length, files: r.files.filter(x => x.path !== f.path) })) }} /></span>
        </div>
        {!collapsed[f.path] && f.matches.map((m, i) => <div key={i} className="sv-match" onClick={() => open(f, m)}>
          <span className="sv-line">{m.before.length > 28 ? '…' + m.before.slice(-26) : m.before.trimStart()}<mark className={cn(showRep && rep !== '' && 'del')}>{m.text}</mark>{showRep && <mark className="add">{opts.isRegex ? '' : rep}</mark>}{m.after.slice(0, 120)}</span>
          <span className="sv-acts">{showRep && <IconButton icon={Replace} size="sm" tip="Replace" onClick={e => { e.stopPropagation(); void replaceOne(f, i) }} />}<IconButton icon={X} size="sm" tip="Dismiss" onClick={e => { e.stopPropagation(); removeMatch(f.path, i) }} /></span>
        </div>)}
      </div>)}
    </div>
  </>
}
