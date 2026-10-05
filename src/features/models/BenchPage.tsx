import { useEffect, useMemo, useState } from 'react'
import { Check, Gauge, Loader2, Play, Square, Trash2 } from 'lucide-react'
import type { BenchCase, BenchResult } from '@shared/ai'
import type { ModelRef } from '@shared/settings'
import { refKey } from '@shared/settings'
import { api, onEvent } from '../../lib/api'
import { cn, formatCost, formatDuration } from '../../lib/util'
import { Button, Checkbox, EmptyState } from '../../components/ui'
import { toast } from '../../stores/ui'
import { useChatModels } from '../ai/Selectors'
import { Group } from '../settings/rows'
import type { BenchProgress } from '@shared/media'

interface Row { key: string; label: string; n: number; ok: number; passed: number; checked: number; ttft: number | null; tps: number; total: number; cost: number }

export function BenchPage() {
  const models = useChatModels()
  const [cases, setCases] = useState<BenchCase[]>([])
  const [results, setResults] = useState<BenchResult[]>([])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [pickedCases, setPickedCases] = useState<Record<string, boolean>>({})
  const [runs, setRuns] = useState(1)
  const [progress, setProgress] = useState<BenchProgress | null>(null)
  const running = !!progress
  useEffect(() => {
    void api.bench.cases().then(c => { setCases(c); setPickedCases(Object.fromEntries(c.map(x => [x.id, true]))) })
    void api.bench.results().then(setResults)
    const a = onEvent('bench:progress', p => setProgress(p.done >= p.total ? null : p))
    const b = onEvent('bench:result', r => setResults(x => [...x.filter(y => y.id !== r.id), r]))
    return () => { a(); b() }
  }, [])
  const chosenModels = models.filter(m => picked[refKey(m.ref)])
  const chosenCases = cases.filter(c => pickedCases[c.id])
  const start = async () => {
    setProgress({ done: 0, total: chosenModels.length * chosenCases.length * runs })
    try { await api.bench.run({ models: chosenModels.map(m => m.ref as ModelRef), caseIds: chosenCases.map(c => c.id), runs }); setResults(await api.bench.results()) } catch (e) { toast.error((e as Error).message) } finally { setProgress(null) }
  }
  const label = (r: ModelRef) => { const m = models.find(x => x.ref.provider === r.provider && x.ref.model === r.model); return m ? `${m.info.name ?? m.info.id}` : r.model }
  const rows: Row[] = useMemo(() => {
    const by = new Map<string, BenchResult[]>()
    for (const r of results) by.set(refKey(r.model), [...(by.get(refKey(r.model)) ?? []), r])
    return [...by.entries()].map(([key, list]) => {
      const ok = list.filter(x => x.ok)
      const ttfts = ok.filter(x => x.ttftMs !== undefined).map(x => x.ttftMs!)
      const checked = list.filter(x => x.passed !== undefined)
      return { key, label: label(list[0].model), n: list.length, ok: ok.length, passed: checked.filter(x => x.passed).length, checked: checked.length, ttft: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null, tps: ok.length ? ok.reduce((a, b) => a + b.tokensPerSec, 0) / ok.length : 0, total: ok.length ? ok.reduce((a, b) => a + b.totalMs, 0) / ok.length : 0, cost: list.reduce((a, b) => a + (b.cost ?? 0), 0) }
    }).sort((a, b) => (b.checked ? b.passed / b.checked : 0) - (a.checked ? a.passed / a.checked : 0) || b.tps - a.tps)
  }, [results, models]) // eslint-disable-line react-hooks/exhaustive-deps
  const maxTps = Math.max(1, ...rows.map(r => r.tps))
  return <div className="page-scroll"><div className="page narrow">
    <div className="page-head"><div><h1 className="serif">Benchmark</h1><p className="page-sub">Compare your models on the same prompts: speed, cost and whether they get the answer right. Runs use your own keys and cost real tokens.</p></div>
      <div className="row gap8">{results.length > 0 && !running && <Button variant="ghost" icon={Trash2} onClick={async () => { await api.bench.clear(); setResults([]) }}>Clear results</Button>}
        {running ? <Button icon={Square} onClick={() => void api.bench.cancel()}>Stop</Button> : <Button variant="primary" icon={Play} disabled={!chosenModels.length || !chosenCases.length} onClick={() => void start()}>Run benchmark</Button>}</div></div>
    {running && progress && <div className="card" style={{ padding: 14 }}><div className="row gap8" style={{ marginBottom: 8 }}><Loader2 size={14} className="spin-anim" /><span className="small">{progress.current ?? 'Running…'}</span><span className="grow" /><span className="small muted">{progress.done} / {progress.total}</span></div><div className="tc-bar" style={{ borderRadius: 2 }}><i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div></div>}
    {models.length === 0 ? <div className="card"><EmptyState icon={Gauge} title="No models to test" text="Connect a provider first, then come back to compare its models." /></div> : <>
      <Group title="Models to test"><div className="bench-pick">{models.map(m => <Checkbox key={refKey(m.ref)} on={!!picked[refKey(m.ref)]} onChange={v => setPicked(p => ({ ...p, [refKey(m.ref)]: v }))} label={<span className="bp-label"><b>{m.info.name ?? m.info.id}</b><span className="subtle"> {m.provider.name}</span></span>} />)}</div></Group>
      <Group title="Prompts"><div className="bench-pick">{cases.map(c => <Checkbox key={c.id} on={!!pickedCases[c.id]} onChange={v => setPickedCases(p => ({ ...p, [c.id]: v }))} label={<span className="bp-label"><b>{c.name}</b><span className="subtle"> {c.category}</span></span>} />)}</div>
        <div className="set-row"><div className="set-row-main"><div className="set-row-title">Repetitions</div><div className="set-row-desc">Run every prompt several times for steadier averages.</div></div><div className="set-row-ctl"><select className="select sm" style={{ width: 70 }} value={runs} onChange={e => setRuns(+e.target.value)}>{[1, 2, 3, 5].map(n => <option key={n}>{n}</option>)}</select></div></div></Group>
    </>}
    {rows.length > 0 && <Group title="Results"><div className="bench-table">
      <div className="bt-head"><span>Model</span><span>Correct</span><span>First token</span><span>Speed</span><span>Avg. time</span><span>Cost</span></div>
      {rows.map(r => <div key={r.key} className="bt-row"><span className="truncate"><b>{r.label}</b>{r.ok < r.n && <span className="badge danger" style={{ marginLeft: 8 }}>{r.n - r.ok} failed</span>}</span>
        <span>{r.checked ? <span className={cn('badge', r.passed === r.checked ? 'success' : r.passed ? 'warning' : 'danger')}>{r.passed === r.checked && <Check size={11} />}{r.passed}/{r.checked}</span> : <span className="subtle">—</span>}</span>
        <span>{r.ttft !== null ? formatDuration(r.ttft) : '—'}</span>
        <span className="bt-bar"><i style={{ width: `${(r.tps / maxTps) * 100}%` }} /><em>{r.tps.toFixed(0)} tok/s</em></span>
        <span>{r.total ? formatDuration(r.total) : '—'}</span><span>{r.cost ? formatCost(r.cost) : '—'}</span></div>)}
    </div></Group>}
  </div></div>
}
