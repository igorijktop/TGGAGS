import { useEffect, useState } from 'react'
import { Activity, Brain, ChevronRight, Eye, Gauge, Image as ImageIcon, KeyRound, Plus, RefreshCw, Trash2, Wrench, Zap, Check, CircleAlert, Loader2 } from 'lucide-react'
import type { ModelInfo, ModelRef, ProviderConfig, RouterRule } from '@shared/settings'
import { api } from '../../lib/api'
import { cn, uid } from '../../lib/util'
import { Badge, Button, EmptyState, IconButton, Segmented, Switch } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { useSettings } from '../../stores/settings'
import { useEditor } from '../../stores/editor'
import { keysChanged, removeProvider, updateProvider } from '../../lib/providers'
import { ModelPicker, useKeyStatus } from '../ai/Selectors'
import { AddProvider } from './AddProvider'
import { Group, NumberField, Row, SelectField, TextField, ToggleRow } from '../settings/rows'

export async function addProviderDialog(): Promise<string | undefined> {
  return dialogs.custom<string>({ title: 'Add a provider', wide: true, render: close => <AddProvider close={close} /> })
}

function Cap({ on, icon: Icon, tip, onClick }: { on?: boolean; icon: typeof Eye; tip: string; onClick(): void }) {
  return <button className={cn('cap', on && 'on')} data-tip={`${tip}: ${on ? 'yes' : 'no'}`} onClick={onClick}><Icon size={13} /></button>
}

function ProviderCard({ p, keyState, open, onToggle }: { p: ProviderConfig; keyState: 'stored' | 'env' | 'none'; open: boolean; onToggle(): void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'test' | 'discover' | null>(null)
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null)
  const [newModel, setNewModel] = useState('')
  const [newKind, setNewKind] = useState<'chat' | 'image' | null>(null) // null = guess from the model id / provider
  const hasKey = keyState !== 'none'
  const patch = (x: Partial<ProviderConfig>) => void updateProvider({ ...p, ...x })
  const kind = newKind ?? guessKind(p.protocol, newModel)
  const newModelEntry = (): ModelInfo => kind === 'image' ? { id: newModel.trim(), modality: 'image' } : { id: newModel.trim(), modality: 'chat', tools: true }
  const patchModel = (id: string, x: Partial<ModelInfo>) => patch({ models: p.models.map(m => (m.id === id ? { ...m, ...x } : m)) })
  const saveKey = async () => { await api.providers.setKey(p.id, key); setKey(''); keysChanged(); toast.success(key.trim() ? 'Key saved.' : 'Key removed.') }
  const test = async () => { setBusy('test'); setRes(null); try { const r = await api.providers.test(p, key.trim() || undefined); setRes({ ok: r.ok, text: r.ok ? `Connected in ${r.ms} ms${r.models !== undefined ? ` · ${r.models} models available` : ''}` : r.message }) } catch (e) { setRes({ ok: false, text: (e as Error).message }) } finally { setBusy(null) } }
  const discover = async () => {
    setBusy('discover')
    try {
      const found = await api.providers.discover(p, key.trim() || undefined)
      const have = new Set(p.models.map(m => m.id))
      const add = found.filter(m => !have.has(m.id))
      patch({ models: [...p.models, ...add] })
      toast.success(add.length ? `Found ${add.length} new model${add.length > 1 ? 's' : ''}.` : 'No new models found.')
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(null) }
  }
  const remove = async () => { if (await dialogs.confirm({ title: `Remove ${p.name}?`, message: 'The provider and its saved key are deleted from this computer.', confirmLabel: 'Remove', danger: true })) await removeProvider(p.id) }
  const status = p.requiresKey ? (hasKey ? <Badge kind="success">{keyState === 'env' ? 'Key from environment' : 'Key saved'}</Badge> : <Badge kind="warning">Needs a key</Badge>) : <Badge kind="success">{p.local ? 'Local' : 'Ready'}</Badge>
  return <div className={cn('card prov-card', !p.enabled && 'off')}>
    <div className="pc-head" onClick={onToggle}>
      <ChevronRight size={15} className={cn('t-chev', open && 'open')} />
      <div className="pc-title"><span className="pc-name">{p.name}</span><span className="pc-sub">{p.protocol} · {p.baseUrl.replace(/^https?:\/\//, '')}</span></div>
      <span className="grow" />{status}<Badge>{p.models.filter(m => m.modality === 'chat').length} chat{p.models.some(m => m.modality === 'image') ? ` · ${p.models.filter(m => m.modality === 'image').length} image` : ''}</Badge>
      <span onClick={e => e.stopPropagation()}><Switch on={p.enabled} onChange={v => patch({ enabled: v })} label={`Enable ${p.name}`} /></span>
    </div>
    {open && <div className="pc-body fade-in">
      <div className="pc-grid">
        <label className="field"><span className="field-label">Server address</span><TextField width="100%" mono value={p.baseUrl} onChange={v => patch({ baseUrl: v.trim().replace(/\/+$/, '') })} /></label>
        <label className="field"><span className="field-label">API key {hasKey && <span className="subtle">· saved{keyState === 'env' ? ` (from ${p.apiKeyEnv})` : ''}</span>}</span>
          <span className="row gap6"><input className="input sm" type="password" placeholder={hasKey ? '•••••••• (type to replace)' : p.requiresKey ? 'Paste your key' : 'Not required'} value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && key.trim()) void saveKey() }} />
            <Button size="sm" icon={KeyRound} disabled={!key.trim()} onClick={() => void saveKey()}>Save</Button>{keyState === 'stored' && <IconButton icon={Trash2} size="sm" tip="Remove saved key" onClick={async () => { await api.providers.setKey(p.id, ''); keysChanged() }} />}</span></label>
      </div>
      <div className="row gap8">
        <Button size="sm" icon={busy === 'test' ? Loader2 : Activity} disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
        <Button size="sm" icon={busy === 'discover' ? Loader2 : RefreshCw} disabled={!!busy} onClick={() => void discover()}>Find models</Button>
        <span className="grow" /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove()}>Remove provider</Button>
      </div>
      {res && <div className={cn('onb-result', res.ok ? 'ok' : 'bad')}>{res.ok ? <Check size={14} /> : <CircleAlert size={14} />}<span className="selectable">{res.text}</span></div>}
      <div className="model-table">
        <div className="mt-head"><span>Model</span><span>Context</span><span>$/1M in · out</span><span>Abilities</span><span /></div>
        {p.models.map(m => <div key={m.id} className="mt-row">
          <span className="mt-name"><input className="mt-input" value={m.name ?? m.id} onChange={e => patchModel(m.id, { name: e.target.value })} /><span className="mono subtle">{m.id}</span></span>
          <NumberField blank width={86} value={m.contextWindow ?? 0} min={0} step={1000} onChange={v => patchModel(m.id, { contextWindow: v || undefined })} />
          <span className="row gap4"><NumberField blank width={54} value={m.inputPrice ?? 0} min={0} step={0.1} onChange={v => patchModel(m.id, { inputPrice: v || undefined })} /><NumberField blank width={54} value={m.outputPrice ?? 0} min={0} step={0.1} onChange={v => patchModel(m.id, { outputPrice: v || undefined })} /></span>
          <span className="row gap4">{m.modality === 'chat' ? <>
            <Cap icon={Wrench} tip="Tool calling" on={m.tools !== false} onClick={() => patchModel(m.id, { tools: m.tools === false })} />
            <Cap icon={Eye} tip="Image input" on={!!m.vision} onClick={() => patchModel(m.id, { vision: !m.vision })} />
            <Cap icon={Brain} tip="Reasoning" on={!!m.reasoning} onClick={() => patchModel(m.id, { reasoning: !m.reasoning })} />
            <Cap icon={ImageIcon} tip="This is an image-generation model" on={false} onClick={() => patchModel(m.id, { modality: 'image', tools: undefined, vision: undefined, reasoning: undefined })} /></> : <button className="badge-btn" data-tip="Image model — click to treat it as a text model" onClick={() => patchModel(m.id, { modality: 'chat', tools: true })}><Badge kind="info">image</Badge></button>}</span>
          <IconButton icon={Trash2} size="sm" tip="Remove model" onClick={() => patch({ models: p.models.filter(x => x.id !== m.id) })} />
        </div>)}
        <div className="mt-add"><Segmented<'chat' | 'image'> value={kind} onChange={setNewKind} options={[{ value: 'chat', label: 'Text' }, { value: 'image', label: 'Image', tip: 'For image generation (Image Studio and the agent’s image tool)' }]} /><input className="input sm mono" placeholder="Add a model by its ID, e.g. gpt-5-mini or gpt-image-1" value={newModel} onChange={e => setNewModel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newModel.trim()) { patch({ models: [...p.models, newModelEntry()] }); setNewModel(''); setNewKind(null) } }} />
          <Button size="sm" icon={Plus} disabled={!newModel.trim()} onClick={() => { patch({ models: [...p.models, newModelEntry()] }); setNewModel(''); setNewKind(null) }}>Add</Button></div>
      </div>
    </div>}
  </div>
}

function Routing() {
  const router = useSettings(s => s.settings.router)
  const setSection = useSettings(s => s.setSection)
  const save = (r: Partial<typeof router>) => void setSection('router', { ...router, ...r })
  const role = (k: keyof typeof router.roles, v: ModelRef | null) => save({ roles: { ...router.roles, [k]: v ?? undefined } })
  const roles: { k: keyof typeof router.roles; label: string; desc: string }[] = [
    { k: 'default', label: 'Everyday model', desc: 'Used when you have not picked one.' }, { k: 'plan', label: 'Planning model', desc: 'Used by the Plan agent — usually your strongest model.' },
    { k: 'small', label: 'Small & fast model', desc: 'Titles, summaries and commit messages.' }, { k: 'vision', label: 'Vision model', desc: 'Used when a message contains images and your main model cannot see them.' },
    { k: 'long', label: 'Long-context model', desc: 'Used when a conversation outgrows the main model’s window.' }
  ]
  const rules = router.rules
  const addRule = () => save({ rules: [...rules, { id: uid('r-'), when: { keywords: [] }, use: router.roles.default ?? { provider: '', model: '' } }] })
  const patchRule = (id: string, p: Partial<RouterRule>) => save({ rules: rules.map(r => (r.id === id ? { ...r, ...p } : r)) })
  return <>
    <Group title="Smart routing" hint="Let the app pick a model per task and fall back to another when a provider is down or rate limited.">
      <ToggleRow title="Enable routing" description="When off, the model you choose in the message box is always used." value={router.enabled} onChange={v => save({ enabled: v })} />
      {roles.map(r => <Row key={r.k} title={r.label} description={r.desc}><span className="row gap6"><ModelPicker value={router.roles[r.k] ?? null} onChange={v => role(r.k, v)} placement="bottom-end" />{router.roles[r.k] && <IconButton icon={Trash2} size="sm" tip="Clear" onClick={() => role(r.k, null)} />}</span></Row>)}
    </Group>
    <Group title="Fallback chain" hint="If a request fails after retries, the next model here is tried.">
      <div className="set-row stack">
        {router.fallbacks.map((f, i) => <div key={i} className="row gap8"><span className="badge">{i + 1}</span><ModelPicker value={f} onChange={v => v && save({ fallbacks: router.fallbacks.map((x, j) => (j === i ? v : x)) })} placement="bottom-start" /><IconButton icon={Trash2} size="sm" onClick={() => save({ fallbacks: router.fallbacks.filter((_, j) => j !== i) })} tip="Remove" /></div>)}
        <div><Button size="sm" icon={Plus} onClick={() => save({ fallbacks: [...router.fallbacks, router.roles.default ?? { provider: '', model: '' }] })}>Add fallback</Button></div>
      </div>
    </Group>
    <Group title="Rules" hint="First matching rule wins. Leave a condition empty to ignore it.">
      <div className="set-row stack">
        {rules.length === 0 && <div className="subtle small">No rules. Example: use a cheaper model when the message mentions “rename” or “typo”.</div>}
        {rules.map(r => <div key={r.id} className="rule-row">
          <SelectField width={120} value={r.when.agent ?? ''} options={[{ value: '', label: 'Any agent' }, { value: 'build', label: 'Build' }, { value: 'plan', label: 'Plan' }]} onChange={v => patchRule(r.id, { when: { ...r.when, agent: v || undefined } })} />
          <TextField width="100%" value={(r.when.keywords ?? []).join(', ')} placeholder="keywords, comma separated" onChange={v => patchRule(r.id, { when: { ...r.when, keywords: v.split(',').map(x => x.trim()).filter(Boolean) } })} />
          <NumberField width={80} value={r.when.minTokens ?? 0} min={0} step={1000} suffix="tok+" onChange={v => patchRule(r.id, { when: { ...r.when, minTokens: v || undefined } })} />
          <ModelPicker value={r.use.provider ? r.use : null} onChange={v => v && patchRule(r.id, { use: v })} placement="bottom-end" />
          <IconButton icon={Trash2} size="sm" tip="Remove rule" onClick={() => save({ rules: rules.filter(x => x.id !== r.id) })} />
        </div>)}
        <div><Button size="sm" icon={Plus} onClick={addRule}>Add rule</Button></div>
      </div>
    </Group>
  </>
}

const IMAGE_ID = /(dall-?e|gpt-image|imagen|stable-?diffusion|\bsdxl\b|\bsd3|flux|midjourney|nano-banana|image(-|$)|-image|ideogram|recraft)/i
/** Image models are told apart by provider protocol or by a telltale model id; the user can always override it. */
const guessKind = (protocol: string, id: string): 'chat' | 'image' => (protocol === 'stability' || protocol === 'a1111' || IMAGE_ID.test(id) ? 'image' : 'chat')

export function ModelsPage() {
  const providers = useSettings(s => s.settings.providers)
  const images = useSettings(s => s.settings.images)
  const update = useSettings(s => s.update)
  const keys = useKeyStatus()
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => { if (providers.length === 1 && openId === null) setOpenId(providers[0].id) }, [providers.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = (e: Event) => setOpenId((e as CustomEvent<string>).detail); window.addEventListener('tgg:open-provider', h); return () => window.removeEventListener('tgg:open-provider', h) }, [])
  const add = async () => { const id = await addProviderDialog(); if (id) setOpenId(id) }
  return <div className="page-scroll"><div className="page">
    <div className="page-head"><div><h1 className="serif">Models & providers</h1><p className="page-sub">Connect the AI services you use. Keys are stored encrypted on this computer and only sent to the provider they belong to. Local models (Ollama, LM Studio) work without internet.</p></div>
      <div className="row gap8"><Button icon={Gauge} onClick={() => useEditor.getState().openPage('bench', undefined, 'Benchmark')}>Benchmark</Button><Button variant="primary" icon={Plus} onClick={() => void add()}>Add provider</Button></div></div>
    {providers.length === 0 ? <div className="card"><EmptyState icon={Zap} title="No providers yet" text="Add Anthropic, OpenAI, Google, OpenRouter, a local Ollama server — or any OpenAI-compatible endpoint."><Button variant="primary" icon={Plus} onClick={() => void add()}>Add your first provider</Button></EmptyState></div>
      : <div className="col gap12">{providers.map(p => <ProviderCard key={p.id} p={p} keyState={keys[p.id] ?? 'none'} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />)}</div>}
    <Group title="Image generation">
      <Row title="Default image model" description="Used by the Image Studio and the agent’s image tool."><ModelPicker modality="image" value={images.defaultModel} onChange={m => void update({ images: { defaultModel: m } } as never)} placement="bottom-end" /></Row>
      <ToggleRow title="Save generated images into the project" description="Otherwise they stay in the image library inside the app’s data folder." value={images.saveToProject} onChange={v => void update({ images: { saveToProject: v } } as never)} />
    </Group>
    <Routing />
  </div></div>
}
