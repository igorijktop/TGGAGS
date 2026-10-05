import { useEffect, useMemo, useState } from 'react'
import { Keyboard, RotateCcw, Search, X } from 'lucide-react'
import { allCommands, eventToBinding, formatKeybinding, keybindingFor } from '../../lib/commands'
import { cn } from '../../lib/util'
import { useSettings } from '../../stores/settings'
import { IconButton } from '../../components/ui'
import { Group } from './rows'

export function KeybindingsSection() {
  const user = useSettings(s => s.settings.keybindings)
  const setSection = useSettings(s => s.setSection)
  const [q, setQ] = useState('')
  const [rec, setRec] = useState<string | null>(null)
  const list = useMemo(() => allCommands().filter(c => !c.hidden).filter(c => !q || `${c.category ?? ''} ${c.title}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.title.localeCompare(b.title)), [q, user])
  const conflicts = useMemo(() => { const m = new Map<string, string[]>(); for (const c of allCommands()) { const k = keybindingFor(c.id); if (k) m.set(k, [...(m.get(k) ?? []), c.title]) } return m }, [user])
  const save = (id: string, v: string | null) => { const next = { ...user }; if (v === null) delete next[id]; else next[id] = v; void setSection('keybindings', next) }
  useEffect(() => {
    if (!rec) return
    const key = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.code === 'Escape') { setRec(null); return }
      if ((e.code === 'Backspace' || e.code === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) { save(rec, ''); setRec(null); return }
      const b = eventToBinding(e)
      if (b) { save(rec, b); setRec(null) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  let lastCat = ''
  return <Group hint="Click a shortcut, then press the new key combination. Press Backspace to unbind, Esc to cancel. Shortcuts work on any keyboard layout.">
    <div className="set-row"><div className="search-input" style={{ width: '100%' }}><Search size={14} /><input className="input sm" placeholder="Search commands…" value={q} onChange={e => setQ(e.target.value)} /></div></div>
    <div className="kb-list">
      {list.map(c => {
        const kb = keybindingFor(c.id); const changed = c.id in user
        const head = c.category && c.category !== lastCat ? (lastCat = c.category) : null
        const dup = kb ? (conflicts.get(kb)?.length ?? 0) > 1 : false
        return <div key={c.id}>
          {head && <div className="kb-cat">{head}</div>}
          <div className="kb-row"><span className="grow truncate">{c.title}</span>
            <button className={cn('kb-key', rec === c.id && 'rec', dup && 'dup')} onClick={() => setRec(rec === c.id ? null : c.id)} data-tip={dup ? `Also used by: ${conflicts.get(kb!)?.filter(t => t !== c.title).join(', ')}` : undefined}>
              {rec === c.id ? <><Keyboard size={13} />Press keys…</> : kb ? formatKeybinding(kb) : <span className="subtle">Not set</span>}
            </button>
            {changed ? <IconButton icon={RotateCcw} size="sm" tip="Reset to default" onClick={() => save(c.id, null)} /> : kb ? <IconButton icon={X} size="sm" tip="Remove shortcut" onClick={() => save(c.id, '')} /> : <span style={{ width: 22 }} />}
          </div>
        </div>
      })}
      {list.length === 0 && <div className="pal-empty">No commands match.</div>}
    </div>
  </Group>
}
