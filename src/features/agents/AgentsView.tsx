import { Bot, Hammer, ListTree, Plus } from 'lucide-react'
import type { AgentConfig } from '@shared/settings'
import { cn } from '../../lib/util'
import { Button, EmptyState, IconButton } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'

const ICON: Record<string, typeof Bot> = { build: Hammer, plan: ListTree }

export function AgentsView() {
  const agents = useAi(s => s.agents)
  const current = useAi(s => s.composer.agent)
  const open = (id?: string) => useEditor.getState().openPage('agents', id ? { agent: id } : undefined, id ? 'Agent' : 'Agents')
  const groups: { title: string; list: AgentConfig[] }[] = [
    { title: 'Main agents', list: agents.filter(a => a.mode !== 'subagent' && !a.hidden) },
    { title: 'Specialists', list: agents.filter(a => a.mode === 'subagent' && !a.hidden) }
  ]
  return <>
    <div className="sb-head"><h2>Agents</h2><IconButton icon={Plus} tip="New agent" size="sm" onClick={() => open('new')} /></div>
    <div className="sb-body" style={{ paddingBottom: 16 }}>
      {agents.length === 0 && <EmptyState icon={Bot} title="No agents" text="Agents are loading…" />}
      {groups.map(g => g.list.length > 0 && <div key={g.title}>
        <div className="section-title" style={{ padding: '10px 16px 4px' }}>{g.title}</div>
        {g.list.map(a => { const I = ICON[a.id] ?? Bot; return <div key={a.id} className={cn('sess-row', current === a.id && 'active')} onClick={() => open(a.id)}>
          <span className="sess-ic" style={{ color: a.color }}><I size={15} /></span>
          <span className="sess-main"><span className="sess-title truncate">{a.name}{!a.builtin && <span className="badge accent" style={{ marginLeft: 6 }}>custom</span>}</span><span className="sess-sub truncate">{a.description}</span></span>
        </div> })}
      </div>)}
      <div style={{ padding: '14px 12px 0' }}><Button icon={Plus} style={{ width: '100%' }} onClick={() => open('new')}>Create custom agent</Button></div>
      <div className="subtle small" style={{ padding: '12px 16px', lineHeight: 1.5 }}>Hand a task to a specialist by typing <b>@name</b> in a message, or let the main agent delegate on its own.</div>
    </div>
  </>
}
