import { Brain, Check, Eye, Gauge, Plus, Server } from 'lucide-react'
import { sameRef } from '@shared/settings'
import { cn, formatTokens } from '../../lib/util'
import { Button, EmptyState, IconButton } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { useEditor } from '../../stores/editor'
import { useAi } from '../../stores/ai'
import { useKeyStatus } from '../ai/Selectors'
import { addProviderDialog } from './ModelsPage'

export function ModelsView() {
  const providers = useSettings(s => s.settings.providers)
  const composerModel = useAi(s => s.composer.model)
  const def = useSettings(s => s.settings.ai.defaultModel)
  const keys = useKeyStatus()
  const current = composerModel ?? def
  const open = (id?: string) => { useEditor.getState().openPage('models', undefined, 'Models & providers'); if (id) setTimeout(() => window.dispatchEvent(new CustomEvent('tgg:open-provider', { detail: id })), 80) }
  return <>
    <div className="sb-head"><h2>Models</h2><IconButton icon={Gauge} tip="Benchmark models" size="sm" onClick={() => useEditor.getState().openPage('bench', undefined, 'Benchmark')} /><IconButton icon={Plus} tip="Add provider" size="sm" onClick={() => void addProviderDialog().then(id => id && open(id))} /></div>
    <div className="sb-body" style={{ paddingBottom: 16 }}>
      {providers.length === 0 && <EmptyState icon={Server} title="No providers yet" text="Connect an AI provider — cloud or local — to start chatting."><Button variant="primary" icon={Plus} onClick={() => void addProviderDialog().then(id => id && open(id))}>Add provider</Button></EmptyState>}
      {providers.map(p => {
        const ready = !p.requiresKey || (keys[p.id] ?? 'none') !== 'none'
        const chat = p.models.filter(m => m.modality === 'chat'), img = p.models.filter(m => m.modality === 'image')
        return <div key={p.id} className="mv-prov">
          <button className="mv-head" onClick={() => open(p.id)}><span className={cn('status-dot', !p.enabled ? '' : ready ? 'ok' : 'warn')} /><span className="truncate grow">{p.name}</span>{!ready && <span className="badge warning">no key</span>}{p.local && <span className="badge success">local</span>}</button>
          {p.enabled && chat.map(m => { const on = sameRef(current, { provider: p.id, model: m.id }); return <button key={m.id} className={cn('mv-model', on && 'on')} onClick={() => useAi.getState().setComposer({ model: { provider: p.id, model: m.id } })} data-tip={on ? 'Used for new messages' : 'Use this model'}>
            <span className="truncate grow">{m.name ?? m.id}</span>{m.vision && <Eye size={12} className="subtle" />}{m.reasoning && <Brain size={12} className="subtle" />}{m.contextWindow ? <span className="subtle tiny">{formatTokens(m.contextWindow)}</span> : null}{on && <Check size={13} className="accent-ic" />}</button> })}
          {p.enabled && img.length > 0 && <div className="mv-note">{img.length} image model{img.length > 1 ? 's' : ''}</div>}
        </div>
      })}
    </div>
  </>
}
