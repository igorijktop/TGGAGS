import { useEffect, useState } from 'react'
import { Bot, Copy, FileCode2, Hammer, ListTree, Plus, Trash2 } from 'lucide-react'
import type { AgentConfig, PermissionRule } from '@shared/settings'
import type { ToolInfo } from '@shared/ai'
import { api } from '../../lib/api'
import { cn, uid } from '../../lib/util'
import { Badge, Button, EmptyState, Segmented } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'
import { ModelPicker, EFFORTS } from '../ai/Selectors'
import { Group, NumberField, Row, SelectField, TextArea, TextField, ToggleRow } from '../settings/rows'

const ICON: Record<string, typeof Bot> = { build: Hammer, plan: ListTree }
const COLORS = ['#C4623F', '#2F6FEB', '#2F7D4F', '#8B5CF6', '#B26B00', '#C23B31', '#1C6B86', '#D6518C']
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function blank(): AgentConfig {
  return { id: '', name: 'My agent', description: 'What this agent is good at', mode: 'all', prompt: 'You are a careful, senior engineer. …', tools: ['*'], color: COLORS[1] }
}

function Editor({ initial, onDone }: { initial: AgentConfig; onDone(): void }) {
  const isNew = !initial.id
  const [a, setA] = useState<AgentConfig>(initial)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [scope, setScope] = useState<'settings' | 'project' | 'global'>(initial.source === 'project-file' ? 'project' : initial.source === 'global-file' ? 'global' : 'settings')
  const locked = !!initial.builtin
  useEffect(() => { void api.tools.list().then(setTools) }, [])
  useEffect(() => { setA(initial) }, [initial])
  const all = a.tools.includes('*') && !a.tools.some(t => t.startsWith('!'))
  const set = (p: Partial<AgentConfig>) => setA(x => ({ ...x, ...p }))
  const toggleTool = (name: string) => set({ tools: a.tools.includes(name) ? a.tools.filter(t => t !== name) : [...a.tools.filter(t => t !== '*'), name] })
  const byCat = tools.reduce<Record<string, ToolInfo[]>>((m, t) => { (m[t.category] ??= []).push(t); return m }, {})
  const save = async () => {
    const id = a.id || slug(a.name)
    if (!id) { toast.warn('Give the agent a name.'); return }
    if (isNew && useAi.getState().agents.some(x => x.id === id)) { toast.warn(`There is already an agent called “${id}”.`); return }
    const cfg: AgentConfig = { ...a, id, builtin: false, name: a.name.trim() || id }
    try {
      if (scope === 'settings') await api.agents.save(cfg); else await api.agents.writeFile(cfg, scope)
      await useAi.getState().loadAgents(); toast.success('Agent saved.'); onDone()
    } catch (e) { toast.error((e as Error).message) }
  }
  const remove = async () => { if (!(await dialogs.confirm({ title: `Delete ${a.name}?`, confirmLabel: 'Delete', danger: true }))) return; await api.agents.remove(a.id); await useAi.getState().loadAgents(); onDone() }
  const rules = a.permissions ?? []
  return <div className="page narrow">
    <div className="page-head"><div><button className="link-btn small" onClick={onDone}>← All agents</button><h1 className="serif" style={{ marginTop: 6 }}>{isNew ? 'New agent' : a.name}</h1>{locked && <p className="page-sub">Built-in agents can’t be edited. Duplicate it to make your own version.</p>}</div>
      <div className="row gap8">{locked ? <Button icon={Copy} variant="primary" onClick={() => { onDone(); setTimeout(() => useEditor.getState().openPage('agents', { agent: 'new', copy: a.id }, 'New agent'), 0) }}>Duplicate</Button> : <>
        {!isNew && !locked && <Button variant="ghost" icon={Trash2} onClick={() => void remove()}>Delete</Button>}<Button variant="primary" onClick={() => void save()}>Save agent</Button></>}</div></div>
    <fieldset disabled={locked} className="fieldset">
      <Group title="Identity">
        <Row title="Name"><TextField width={240} value={a.name} onChange={v => set({ name: v })} /></Row>
        <Row title="Description" description="Shown in menus and used by the main agent to decide when to delegate."><TextField width={320} value={a.description} onChange={v => set({ description: v })} /></Row>
        <Row title="Where it appears" description="A main agent can be chosen for a chat; a specialist is called by other agents or with @name."><Segmented value={a.mode} options={[{ value: 'primary', label: 'Main' }, { value: 'subagent', label: 'Specialist' }, { value: 'all', label: 'Both' }]} onChange={v => set({ mode: v })} /></Row>
        <Row title="Colour"><span className="row gap6">{COLORS.map(c => <button key={c} className={cn('swatch', a.color === c && 'on')} style={{ background: c }} onClick={() => set({ color: c })} aria-label={`Colour ${c}`} />)}</span></Row>
      </Group>
      <Group title="Instructions" hint="Tell the agent who it is, how to work, and what to avoid. Project rules in AGENTS.md are added automatically.">
        <div className="set-row stack"><TextArea rows={9} value={a.prompt} onChange={v => set({ prompt: v })} /></div>
      </Group>
      <Group title="Model & behaviour">
        <Row title="Model" description="Leave unset to use whichever model is selected in the chat."><span className="row gap6"><ModelPicker value={a.model ?? null} onChange={m => set({ model: m ?? undefined })} placement="bottom-end" />{a.model && <Button size="sm" variant="ghost" onClick={() => set({ model: undefined })}>Clear</Button>}</span></Row>
        <Row title="Reasoning effort"><SelectField value={a.reasoning ?? ''} options={[{ value: '', label: 'Use chat setting' } as never, ...EFFORTS.map(e => ({ value: e.id, label: e.label }))]} onChange={v => set({ reasoning: (v || undefined) as never })} /></Row>
        <Row title="Creativity" description="Lower is more precise; higher is more varied. Some models ignore this."><NumberField value={a.temperature ?? 0} min={0} max={2} step={0.1} onChange={v => set({ temperature: v })} /></Row>
        <Row title="Maximum steps"><NumberField blank placeholder="default" value={a.maxSteps ?? 0} min={0} max={400} onChange={v => set({ maxSteps: v || undefined })} /></Row>
        <ToggleRow title="Project instructions" description="Include AGENTS.md / CLAUDE.md from the project." value={a.contextRules?.projectInstructions !== false} onChange={v => set({ contextRules: { ...a.contextRules, projectInstructions: v } })} />
        <ToggleRow title="Memory" description="Include saved project and global memory." value={a.contextRules?.memory !== false} onChange={v => set({ contextRules: { ...a.contextRules, memory: v } })} />
        <ToggleRow title="Automatic context" description="Attach the open file, selection and relevant files." value={a.contextRules?.autoContext !== false} onChange={v => set({ contextRules: { ...a.contextRules, autoContext: v } })} />
      </Group>
      <Group title="Tools">
        <ToggleRow title="Allow every tool" description="Includes tools from MCP servers and extensions." value={all} onChange={v => set({ tools: v ? ['*'] : tools.filter(t => t.category === 'read' || t.category === 'lsp' || t.category === 'todo').map(t => t.name) })} />
        {!all && <div className="set-row stack">{Object.entries(byCat).map(([cat, list]) => <div key={cat}><div className="section-title" style={{ marginBottom: 6 }}>{cat}</div><div className="tool-pick">{list.map(t => <button key={t.name} className={cn('tool-chip', a.tools.includes(t.name) && 'on')} data-tip={t.description} onClick={() => toggleTool(t.name)}>{t.name}</button>)}</div></div>)}</div>}
      </Group>
      <Group title="Permission overrides" hint="Rules here apply only to this agent, on top of your global permissions.">
        <div className="set-row stack">
          {rules.map(r => <div key={r.id} className="rule-row">
            <TextField width={110} value={r.tool} onChange={v => set({ permissions: rules.map(x => (x.id === r.id ? { ...x, tool: v } : x)) })} />
            <TextField width="100%" mono value={r.pattern ?? ''} placeholder="pattern (optional)" onChange={v => set({ permissions: rules.map(x => (x.id === r.id ? { ...x, pattern: v || undefined } : x)) })} />
            <SelectField width={96} value={r.action} options={[{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask me' }, { value: 'deny', label: 'Deny' }]} onChange={v => set({ permissions: rules.map(x => (x.id === r.id ? { ...x, action: v } : x)) })} />
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => set({ permissions: rules.filter(x => x.id !== r.id) })} />
          </div>)}
          <div><Button size="sm" icon={Plus} onClick={() => set({ permissions: [...rules, { id: uid('rule-'), tool: 'shell', pattern: '', action: 'ask' } as PermissionRule] })}>Add override</Button></div>
        </div>
      </Group>
    </fieldset>
    {!locked && <Group title="Save to"><Row title="Location" description={scope === 'settings' ? 'Kept in the app settings; available in every project.' : scope === 'project' ? 'Written to .tgg/agents/ inside this project so it can be committed and shared.' : 'Written to your user folder; available in every project.'}>
      <SelectField width={190} value={scope} options={[{ value: 'settings', label: 'App settings' }, { value: 'project', label: 'This project (file)' }, { value: 'global', label: 'User folder (file)' }] as { value: 'settings' | 'project' | 'global'; label: string }[]} onChange={v => setScope(v as 'settings' | 'project' | 'global')} /></Row></Group>}
    <FileCode2 size={0} style={{ display: 'none' }} />
  </div>
}

export function AgentsPage({ agentId, copy }: { agentId?: string; copy?: string }) {
  const agents = useAi(s => s.agents)
  const [sel, setSel] = useState<string | null>(agentId ?? null)
  useEffect(() => { setSel(agentId ?? null) }, [agentId])
  const list = agents.filter(a => !a.hidden)
  if (sel) {
    const found = sel === 'new' ? (copy ? (() => { const s = agents.find(a => a.id === copy); return s ? { ...s, id: '', builtin: false, name: `${s.name} copy`, source: undefined, filePath: undefined } : blank() })() : blank()) : agents.find(a => a.id === sel)
    return <div className="page-scroll">{found ? <Editor initial={found} onDone={() => setSel(null)} /> : <EmptyState title="Agent not found" />}</div>
  }
  return <div className="page-scroll"><div className="page">
    <div className="page-head"><div><h1 className="serif">Agents</h1><p className="page-sub">Agents are specialists with their own instructions, tools, model and permissions. Switch the main agent from the message box, or mention <b>@name</b> to hand a task to a specialist.</p></div><Button variant="primary" icon={Plus} onClick={() => setSel('new')}>New agent</Button></div>
    <div className="agent-grid">{list.map(a => { const I = ICON[a.id] ?? Bot; return <button key={a.id} className="card agent-card" onClick={() => setSel(a.id)}>
      <span className="ac-ic" style={{ background: `color-mix(in srgb, ${a.color ?? 'var(--accent)'} 14%, transparent)`, color: a.color ?? 'var(--accent-strong)' }}><I size={18} /></span>
      <span className="ac-main"><span className="ac-name">{a.name}</span><span className="ac-desc">{a.description}</span><span className="row gap4" style={{ marginTop: 6 }}><Badge>{a.mode === 'subagent' ? 'Specialist' : a.mode === 'primary' ? 'Main' : 'Main & specialist'}</Badge>{a.builtin ? <Badge>Built-in</Badge> : <Badge kind="accent">Custom</Badge>}{a.model && <Badge kind="info">{a.model.model}</Badge>}</span></span>
    </button> })}</div>
  </div></div>
}
