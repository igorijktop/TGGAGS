import { useEffect, useMemo, useState } from 'react'
import { Bot, Brain, Check, ChevronDown, Eye, Gauge, Hammer, ListTree, Lock, Pencil, Plus, Search, ShieldAlert, ShieldCheck, Sparkles, Wrench, Zap, type LucideIcon } from 'lucide-react'
import type { AgentConfig, ModelInfo, ModelRef, PermissionMode, ProviderConfig, ReasoningEffort } from '@shared/settings'
import { sameRef } from '@shared/settings'
import { api } from '../../lib/api'
import { cn, formatTokens } from '../../lib/util'
import { Popover } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'

export interface ChatModelEntry { ref: ModelRef; provider: ProviderConfig; info: ModelInfo; ready: boolean }

export function useKeyStatus(): Record<string, 'stored' | 'env' | 'none'> {
  const providers = useSettings(s => s.settings.providers)
  const [st, setSt] = useState<Record<string, 'stored' | 'env' | 'none'>>({})
  useEffect(() => {
    let dead = false
    const load = () => api.providers.keyStatus().then(r => { if (!dead) setSt(r) }).catch(() => undefined)
    void load()
    window.addEventListener('tgg:keys-changed', load)
    return () => { dead = true; window.removeEventListener('tgg:keys-changed', load) }
  }, [providers])
  return st
}

export function useChatModels(modality: 'chat' | 'image' = 'chat'): ChatModelEntry[] {
  const providers = useSettings(s => s.settings.providers)
  const keys = useKeyStatus()
  return useMemo(() => providers.filter(p => p.enabled).flatMap(p => p.models.filter(m => m.modality === modality).map(info => ({
    ref: { provider: p.id, model: info.id }, provider: p, info, ready: !p.requiresKey || (keys[p.id] ?? 'none') !== 'none'
  }))), [providers, keys, modality])
}

export function modelLabel(ref: ModelRef | null | undefined, providers: ProviderConfig[]): string | null {
  if (!ref) return null
  const p = providers.find(x => x.id === ref.provider)
  return p?.models.find(x => x.id === ref.model)?.name ?? ref.model
}

// ───────────── generic dropdown trigger ─────────────
function Trigger({ icon: Icon, label, tip, onClick, active, className, caret = true }: { icon?: LucideIcon; label: string; tip?: string; onClick(e: React.MouseEvent<HTMLElement>): void; active?: boolean; className?: string; caret?: boolean }) {
  return <button type="button" className={cn('sel-btn', active && 'active', className)} data-tip={tip} onClick={onClick}>{Icon && <Icon size={13} strokeWidth={1.9} />}<span className="truncate">{label}</span>{caret && <ChevronDown size={12} className="caret" />}</button>
}

// ───────────── model picker ─────────────
export function ModelPicker({ value, onChange, modality = 'chat', placement = 'top-end', label: forced }: { value: ModelRef | null; onChange(v: ModelRef | null): void; modality?: 'chat' | 'image'; placement?: 'top-end' | 'bottom-end' | 'bottom-start' | 'top-start'; label?: string }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [q, setQ] = useState('')
  const models = useChatModels(modality)
  const providers = useSettings(s => s.settings.providers)
  const router = useSettings(s => s.settings.router)
  const resolved = value ?? (modality === 'chat' ? router.roles.default ?? models.find(m => m.ready)?.ref ?? null : null)
  const name = forced ?? modelLabel(resolved, providers) ?? (models.length ? 'Choose a model' : 'Connect a model')
  const filtered = models.filter(m => !q || `${m.info.name ?? m.info.id} ${m.provider.name}`.toLowerCase().includes(q.toLowerCase()))
  const groups = [...new Set(filtered.map(m => m.provider.id))].map(id => ({ p: providers.find(x => x.id === id)!, items: filtered.filter(m => m.provider.id === id) }))
  const manage = () => { setEl(null); useEditor.getState().openPage('models', undefined, 'Models & providers') }
  if (!models.length) return <button type="button" className="sel-btn warn" onClick={manage} data-tip="Add an AI provider to start chatting"><Plus size={13} /><span>Connect a model</span></button>
  return <>
    <Trigger icon={Sparkles} label={name} tip={modality === 'chat' ? 'Model' : 'Image model'} active={!!el} onClick={e => { setQ(''); setEl(el ? null : e.currentTarget) }} className="model" />
    {el && <Popover anchor={el} placement={placement} onClose={() => setEl(null)} className="model-pop" width={340}>
      {models.length > 7 && <div className="search-input" style={{ padding: '2px 2px 6px' }}><Search size={14} /><input autoFocus className="input sm" placeholder="Search models" value={q} onChange={e => setQ(e.target.value)} style={{ paddingLeft: 28 }} /></div>}
      <div className="model-list">
        {modality === 'chat' && router.enabled && <button className={cn('model-row', !value && 'on')} onClick={() => { onChange(null); setEl(null) }}><span className="mr-main"><span className="mr-name">Smart routing</span><span className="mr-sub">Pick the best model per task using your routing rules</span></span>{!value && <Check size={14} />}</button>}
        {groups.map(g => <div key={g.p.id}>
          <div className="menu-title">{g.p.name}{g.items[0] && !g.items[0].ready && <span className="badge warning" style={{ marginLeft: 8 }}>no key</span>}</div>
          {g.items.map(m => <button key={m.ref.model} className={cn('model-row', sameRef(m.ref, resolved) && value && 'on', !m.ready && 'dim')} onClick={() => { onChange(m.ref); setEl(null) }}>
            <span className="mr-main"><span className="mr-name truncate">{m.info.name ?? m.info.id}</span>
              <span className="mr-sub">{[m.info.contextWindow ? `${formatTokens(m.info.contextWindow)} context` : null, m.info.inputPrice !== undefined ? `$${m.info.inputPrice}/$${m.info.outputPrice} per 1M` : null].filter(Boolean).join(' · ')}</span></span>
            <span className="mr-caps">{m.info.vision && <Eye size={12} data-tip="Understands images" />}{m.info.reasoning && <Brain size={12} data-tip="Reasoning" />}{m.info.tools === false && <Wrench size={12} style={{ opacity: .4 }} data-tip="No tool calling" />}</span>
            {sameRef(m.ref, resolved) && value && <Check size={14} className="accent-ic" />}
          </button>)}
        </div>)}
        {!filtered.length && <div className="pal-empty">No models match.</div>}
      </div>
      <div className="menu-sep" /><button className="menu-item" onClick={manage}><span className="mi-icon"><Plus size={15} /></span><span className="mi-label">Manage providers & models…</span></button>
    </Popover>}
  </>
}

// ───────────── reasoning effort ─────────────
export const EFFORTS: { id: ReasoningEffort; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'No extended thinking — fastest' },
  { id: 'low', label: 'Low', hint: 'Quick answers' },
  { id: 'medium', label: 'Medium', hint: 'Balanced' },
  { id: 'high', label: 'High', hint: 'Careful, slower' },
  { id: 'xhigh', label: 'Extra', hint: 'Deep reasoning for hard problems' },
  { id: 'max', label: 'Max', hint: 'Maximum effort' }
]

export function EffortPicker({ value, onChange, placement = 'top-end' }: { value: ReasoningEffort; onChange(v: ReasoningEffort): void; placement?: 'top-end' | 'bottom-end' | 'bottom-start' | 'top-start' }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const cur = EFFORTS.find(e => e.id === value) ?? EFFORTS[2]
  return <>
    <Trigger icon={Gauge} label={cur.label} tip="Reasoning effort" active={!!el} onClick={e => setEl(el ? null : e.currentTarget)} />
    {el && <Popover anchor={el} placement={placement} onClose={() => setEl(null)} width={260}>
      <div className="menu-title">Reasoning effort</div>
      {EFFORTS.map(e => <button key={e.id} className="menu-item" onClick={() => { onChange(e.id); setEl(null) }}><span className="mi-check">{e.id === value && <Check size={14} />}</span><span className="mi-label"><div>{e.label}</div><div className="subtle" style={{ fontSize: 11.5 }}>{e.hint}</div></span></button>)}
    </Popover>}
  </>
}

// ───────────── permission mode ─────────────
export const MODES: { id: PermissionMode; label: string; title: string; hint: string; icon: LucideIcon }[] = [
  { id: 'ask', label: 'Ask', title: 'Ask before acting', hint: 'Confirm every edit, command and web request.', icon: ShieldCheck },
  { id: 'auto-edit', label: 'Auto', title: 'Auto-accept edits', hint: 'Edits inside the project are applied automatically; commands and web access still ask.', icon: Zap },
  { id: 'plan', label: 'Plan', title: 'Plan only', hint: 'Read-only. The agent explores and proposes a plan without changing anything.', icon: ListTree },
  { id: 'yolo', label: 'Bypass', title: 'Bypass permissions', hint: 'Run everything without asking. Destructive commands stay blocked. Use with care.', icon: ShieldAlert }
]

export function ModePicker({ value, onChange, placement = 'top-end' }: { value: PermissionMode; onChange(v: PermissionMode): void; placement?: 'top-end' | 'bottom-end' | 'bottom-start' | 'top-start' }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const cur = MODES.find(m => m.id === value) ?? MODES[1]
  return <>
    <Trigger icon={cur.icon} label={cur.label} tip={`Permissions: ${cur.title}`} active={!!el} className={cn(value === 'yolo' && 'danger')} onClick={e => setEl(el ? null : e.currentTarget)} />
    {el && <Popover anchor={el} placement={placement} onClose={() => setEl(null)} width={330}>
      <div className="menu-title">What may the agent do on its own?</div>
      {MODES.map(m => <button key={m.id} className="menu-item" style={{ alignItems: 'flex-start', padding: '7px 10px' }} onClick={() => { onChange(m.id); setEl(null) }}>
        <span className="mi-icon" style={{ marginTop: 2 }}><m.icon size={15} /></span>
        <span className="mi-label"><div style={{ fontWeight: 500 }}>{m.title}</div><div className="subtle" style={{ fontSize: 11.5, lineHeight: 1.4, whiteSpace: 'normal' }}>{m.hint}</div></span>
        {m.id === value && <Check size={14} className="accent-ic" style={{ marginTop: 2 }} />}
      </button>)}
    </Popover>}
  </>
}

// ───────────── agent picker ─────────────
const AGENT_ICON: Record<string, LucideIcon> = { build: Hammer, plan: ListTree }

export function AgentPicker({ value, onChange, placement = 'top-start' }: { value: string; onChange(v: string): void; placement?: 'top-end' | 'bottom-end' | 'bottom-start' | 'top-start' }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const agents = useAi(s => s.agents)
  const primary = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
  const cur = agents.find(a => a.id === value)
  const Icon = AGENT_ICON[value] ?? Bot
  return <>
    <Trigger icon={Icon} label={cur?.name ?? value} tip="Agent" active={!!el} onClick={e => setEl(el ? null : e.currentTarget)} />
    {el && <Popover anchor={el} placement={placement} onClose={() => setEl(null)} width={310}>
      <div className="menu-title">Agent</div>
      {primary.map((a: AgentConfig) => { const I = AGENT_ICON[a.id] ?? Bot; return <button key={a.id} className="menu-item" style={{ alignItems: 'flex-start', padding: '7px 10px' }} onClick={() => { onChange(a.id); setEl(null) }}>
        <span className="mi-icon" style={{ marginTop: 2, color: a.color }}><I size={15} /></span>
        <span className="mi-label"><div style={{ fontWeight: 500 }}>{a.name}</div><div className="subtle" style={{ fontSize: 11.5, lineHeight: 1.4, whiteSpace: 'normal' }}>{a.description}</div></span>
        {a.id === value && <Check size={14} className="accent-ic" style={{ marginTop: 2 }} />}
      </button> })}
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => { setEl(null); useEditor.getState().openPage('agents', undefined, 'Agents') }}><span className="mi-icon"><Pencil size={15} /></span><span className="mi-label">Manage agents…</span></button>
      <div className="subtle" style={{ fontSize: 11, padding: '4px 10px 6px' }}>Tip: type <b>@name</b> in a message to hand it to a specialist agent.</div>
    </Popover>}
  </>
}

void Lock
