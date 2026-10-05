import { useState } from 'react'
import { Check, CircleAlert, Loader2, Search } from 'lucide-react'
import { PROVIDER_PRESETS, presetToProvider, type ProviderPreset } from '@shared/presets'
import { api } from '../../lib/api'
import { cn } from '../../lib/util'
import { Button } from '../../components/ui'
import { connectPreset } from '../../lib/providers'

/** Picker + form used by the “Add provider” dialog. */
export function AddProvider({ close }: { close(v?: unknown): void }) {
  const [q, setQ] = useState('')
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null)
  const list = PROVIDER_PRESETS.filter(p => !q || `${p.name} ${p.blurb}`.toLowerCase().includes(q.toLowerCase()))
  const choose = (p: ProviderPreset) => { setPreset(p); setKey(''); setUrl(p.baseUrl); setName(p.name); setRes(null) }
  const custom = !!preset && preset.presetId.startsWith('custom')
  const connect = async (skipTest?: boolean) => {
    if (!preset) return
    setBusy(true); setRes(null)
    try {
      const cfg = presetToProvider(preset, 'probe')
      cfg.baseUrl = url.trim() || preset.baseUrl
      if (!skipTest) {
        const r = await api.providers.test(cfg, key.trim() || undefined)
        if (!r.ok) { setRes({ ok: false, text: r.message || 'Could not reach the provider.' }); return }
      }
      const added = await connectPreset(preset, { key: key.trim() || undefined, baseUrl: url.trim() || undefined, name: name.trim() || undefined })
      close(added.id)
    } catch (e) { setRes({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  if (!preset) return <div className="add-prov">
    <div className="search-input"><Search size={14} /><input className="input" autoFocus placeholder="Search providers…" value={q} onChange={e => setQ(e.target.value)} /></div>
    <div className="prov-grid three">{list.map(p => <button key={p.presetId} className="prov" onClick={() => choose(p)}><span className="pv-name">{p.name}</span><span className="pv-blurb">{p.blurb}</span><span className="row gap4">{p.local && <span className="badge success">Offline</span>}{p.models.some(m => m.modality === 'image') && <span className="badge info">Images</span>}</span></button>)}</div>
  </div>
  return <div className="add-prov form">
    <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setPreset(null)}>← All providers</button>
    <div><h3 style={{ fontSize: 17 }}>{preset.name}</h3><p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>{preset.blurb}</p></div>
    {custom && <label className="field"><span className="field-label">Display name</span><input className="input" value={name} onChange={e => setName(e.target.value)} /></label>}
    {(!preset.requiresKey || custom || preset.local) && <label className="field"><span className="field-label">Server address</span><input className="input mono" value={url} onChange={e => setUrl(e.target.value)} /></label>}
    {(preset.requiresKey || custom) && <label className="field"><span className="field-label">API key{!preset.requiresKey && ' (optional)'}</span><input className="input" type="password" autoFocus placeholder="Paste your key" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void connect() }} /><span className="field-hint">Stored encrypted on this computer. Only sent to {custom ? 'this server' : preset.name}.</span></label>}
    {res && <div className={cn('onb-result', res.ok ? 'ok' : 'bad')}>{res.ok ? <Check size={14} /> : <CircleAlert size={14} />}<span className="selectable">{res.text}</span></div>}
    <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
      {res && !res.ok && <Button variant="ghost" onClick={() => void connect(true)}>Add anyway</Button>}
      <Button variant="primary" disabled={busy || (preset.requiresKey && !key.trim())} onClick={() => void connect()}>{busy && <Loader2 size={14} className="spin-anim" />}{busy ? 'Testing…' : 'Test & add'}</Button>
    </div>
  </div>
}
