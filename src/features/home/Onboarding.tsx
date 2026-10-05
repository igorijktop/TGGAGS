import { useState } from 'react'
import { ArrowRight, Check, CircleAlert, FolderGit2, FolderOpen, Loader2 } from 'lucide-react'
import { PROVIDER_PRESETS, presetToProvider, type ProviderPreset } from '@shared/presets'
import { api } from '../../lib/api'
import { cn } from '../../lib/util'
import { Button } from '../../components/ui'
import { Logo } from '../../components/brand'
import { allThemes } from '../../lib/theme'
import { connectPreset } from '../../lib/providers'
import { useSettings } from '../../stores/settings'
import { runCommand } from '../../lib/commands'
import { useWorkspace } from '../../stores/workspace'

const FEATURED = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'ollama', 'lmstudio', 'custom-openai']

export function ThemeCard({ id, name, kind, ui, on, onPick }: { id: string; name: string; kind: string; ui: Record<string, string>; on: boolean; onPick(): void }) {
  return <button className={cn('theme-card', on && 'on')} onClick={onPick} aria-pressed={on} aria-label={`${name} theme`}>
    <span className="tc-prev" style={{ background: ui['--bg-sidebar'], borderColor: ui['--border'] }}>
      <i className="tc-side" style={{ background: ui['--bg-sidebar'], borderRight: `1px solid ${ui['--border']}` }}><b style={{ background: ui['--accent'] }} /><b style={{ background: ui['--border-strong'] }} /><b style={{ background: ui['--border-strong'] }} /></i>
      <i className="tc-main" style={{ background: ui['--bg'] }}><b style={{ background: ui['--fg'], width: '55%' }} /><b style={{ background: ui['--fg-subtle'], width: '80%' }} /><b style={{ background: ui['--accent'], width: '30%', height: 8, borderRadius: 4 }} /></i>
    </span>
    <span className="tc-name">{name}{on && <Check size={13} />}</span><span className="tc-kind">{kind}</span>
  </button>
}

export function Onboarding() {
  const [step, setStep] = useState(0)
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const theme = useSettings(s => s.settings.appearance.theme)
  const update = useSettings(s => s.update)
  const hasRoot = useWorkspace(s => !!s.root)
  const finish = () => { void update({ ui: { onboarded: true } } as never) }

  const choose = (p: ProviderPreset) => { setPreset(p); setKey(''); setUrl(p.baseUrl); setResult(null) }
  const connect = async () => {
    if (!preset) return
    setBusy(true); setResult(null)
    try {
      const cfg = presetToProvider(preset, 'test')
      cfg.baseUrl = url.trim() || preset.baseUrl
      const r = await api.providers.test(cfg, key.trim() || undefined)
      if (!r.ok) { setResult({ ok: false, text: r.message || 'Could not reach the provider.' }); return }
      await connectPreset(preset, { key: key.trim() || undefined, baseUrl: url.trim() || undefined })
      setConnected(preset.name); setResult({ ok: true, text: `Connected in ${r.ms} ms.` })
      setTimeout(() => setStep(2), 700)
    } catch (e) { setResult({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  const presets = FEATURED.map(id => PROVIDER_PRESETS.find(p => p.presetId === id)!).filter(Boolean)
  return <div className="onb-overlay" role="dialog" aria-modal="true" aria-label="Welcome">
    <div className="onb fade-in">
      <div className="onb-steps">{['Look', 'Model', 'Project'].map((s, i) => <span key={s} className={cn('onb-dot', i === step && 'on', i < step && 'done')}><span className="n">{i < step ? <Check size={11} strokeWidth={3} /> : i + 1}</span><em>{s}</em></span>)}</div>
      {step === 0 && <div className="onb-body">
        <Logo size={56} />
        <h1 className="serif">Welcome to TGGAGS</h1>
        <p>An AI-powered code editor that runs on your computer. Let’s set it up — it takes about a minute, and you can change everything later.</p>
        <div className="onb-label">Pick a look</div>
        <div className="theme-grid">{allThemes().filter(t => t.id.startsWith('tgg-')).map(t => <ThemeCard key={t.id} id={t.id} name={t.name} kind={t.kind === 'dark' ? 'Dark' : 'Light'} ui={t.ui} on={theme === t.id} onPick={() => void update({ appearance: { theme: t.id } } as never)} />)}</div>
        <div className="onb-foot"><Button variant="ghost" onClick={finish}>Skip setup</Button><Button variant="primary" size="lg" onClick={() => setStep(1)}>Continue<ArrowRight size={16} /></Button></div>
      </div>}
      {step === 1 && <div className="onb-body">
        <h1 className="serif">Connect an AI model</h1>
        <p>Choose a provider. Your API key is stored encrypted on this computer and only ever sent to that provider. Prefer to stay offline? Pick a local option like Ollama.</p>
        <div className="prov-grid">{presets.map(p => <button key={p.presetId} className={cn('prov', preset?.presetId === p.presetId && 'on')} onClick={() => choose(p)}><span className="pv-name">{p.name}</span><span className="pv-blurb">{p.blurb}</span>{p.local && <span className="badge success">Offline</span>}</button>)}</div>
        {preset && <div className="onb-form fade-in">
          {preset.requiresKey && <label className="field"><span className="field-label">{preset.name} API key</span><input className="input" type="password" autoFocus placeholder="Paste your key" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && key.trim()) void connect() }} /></label>}
          {(!preset.requiresKey || preset.presetId === 'custom-openai') && <label className="field"><span className="field-label">Server address</span><input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder={preset.baseUrl} /></label>}
          {result && <div className={cn('onb-result', result.ok ? 'ok' : 'bad')}>{result.ok ? <Check size={14} /> : <CircleAlert size={14} />}<span className="selectable">{result.text}</span></div>}
          <Button variant="primary" disabled={busy || (preset.requiresKey && !key.trim())} onClick={() => void connect()}>{busy ? <Loader2 size={15} className="spin-anim" /> : null}{busy ? 'Testing…' : connected ? 'Connected' : 'Test & connect'}</Button>
        </div>}
        <div className="onb-foot"><Button variant="ghost" onClick={() => setStep(0)}>Back</Button><span className="grow" /><Button variant="ghost" onClick={() => setStep(2)}>Skip for now</Button></div>
      </div>}
      {step === 2 && <div className="onb-body">
        <h1 className="serif">{connected ? `${connected} is ready.` : 'Almost there.'}</h1>
        <p>Open a folder for the AI to work in — or start with an empty window and pick one later.</p>
        <div className="onb-actions">
          <button className="quick big" onClick={async () => { await runCommand('file.openFolder'); finish() }}><span className="q-ic"><FolderOpen size={20} /></span><span className="q-main"><span className="q-title">Open a folder</span><span className="q-text">Use a project that is already on your computer</span></span></button>
          <button className="quick big" onClick={async () => { await runCommand('git.clone'); finish() }}><span className="q-ic"><FolderGit2 size={20} /></span><span className="q-main"><span className="q-title">Clone a repository</span><span className="q-text">Download a project from GitHub or any Git URL</span></span></button>
        </div>
        <div className="onb-foot"><Button variant="ghost" onClick={() => setStep(1)}>Back</Button><span className="grow" /><Button variant="primary" size="lg" onClick={finish}>{hasRoot ? 'Start' : 'Start without a project'}<ArrowRight size={16} /></Button></div>
      </div>}
    </div>
  </div>
}
