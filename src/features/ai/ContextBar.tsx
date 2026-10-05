import { useState } from 'react'
import { Check, ChevronRight, Eraser, FileText, Folder, GitCompare, ImageIcon, Link2, NotebookPen, Pin, PinOff, Sparkles, SquareTerminal, TextSelect, TriangleAlert, X, Layers, Brain, BookOpen, type LucideIcon } from 'lucide-react'
import type { ContextItem, ContextKind } from '@shared/ai'
import { cn, formatNumber, formatTokens } from '../../lib/util'
import { Popover } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { api } from '../../lib/api'
import { useEditor } from '../../stores/editor'
import { toast } from '../../stores/ui'

const ICON: Record<ContextKind, LucideIcon> = {
  file: FileText, folder: Folder, selection: TextSelect, diff: GitCompare, terminal: SquareTerminal, diagnostics: TriangleAlert, url: Link2, image: ImageIcon, note: NotebookPen,
  tabs: Layers, instructions: BookOpen, memory: Brain, skill: Sparkles
}

export function ContextMeter({ used, window: win, compact }: { used: number; window: number; compact?: boolean }) {
  const pct = win > 0 ? Math.min(1, used / win) : 0
  const tone = pct > 0.9 ? 'danger' : pct > 0.7 ? 'warn' : 'ok'
  return <span className={cn('ctx-meter', tone)} data-tip={`${formatNumber(used)} of ${formatNumber(win)} tokens used (${Math.round(pct * 100)}%)`}>
    <span className="cm-bar"><i style={{ width: `${Math.max(2, pct * 100)}%` }} /></span>
    <span className="cm-num">{compact ? `${formatTokens(used)} / ${formatTokens(win)}` : `${formatNumber(used)} / ${formatNumber(win)} tokens`}</span>
  </span>
}

export function ContextBar({ sessionId }: { sessionId: string | null }) {
  const snap = useAi(s => (sessionId ? s.context[sessionId] : undefined))
  const running = useAi(s => (sessionId ? !!s.running[sessionId] : false))
  const setItems = useAi(s => s.setContextItems)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ el: HTMLElement; item: ContextItem } | null>(null)
  if (!snap || (!snap.items.length && snap.used < 1)) return null
  const items = snap.items
  const manual = items.filter(i => !i.auto)
  const save = (next: ContextItem[]) => void setItems(next.filter(i => !i.auto))
  const patch = (id: string, p: Partial<ContextItem>) => save(manual.map(i => (i.id === id ? { ...i, ...p } : i)))
  const remove = (id: string) => save(manual.filter(i => i.id !== id))
  const keep = (it: ContextItem) => save([...manual, { ...it, auto: false, pinned: true, once: false }])
  const compact = async () => { if (!sessionId) return; const ok = await api.ai.compact(sessionId); toast[ok ? 'success' : 'info'](ok ? 'Conversation compacted into a summary.' : 'Nothing to compact yet.') }
  const pct = snap.window > 0 ? snap.used / snap.window : 0
  const visible = open ? items : items.slice(0, 6)
  return (
    <div className="ctx-bar">
      <div className="ctx-head">
        <button className="ctx-toggle" onClick={() => setOpen(!open)}><ChevronRight size={13} className={cn('t-chev', open && 'open')} /><span className="section-title">Context</span></button>
        <ContextMeter used={snap.used} window={snap.window} />
        <span className="grow" />
        {pct > 0.45 && !running && <button className="link-btn small" onClick={compact} data-tip="Summarise older messages to free up space">Compact</button>}
      </div>
      <div className="ctx-chips">
        {visible.map(it => {
          const I = ICON[it.kind] ?? FileText
          return <span key={it.id} className={cn('ctx-chip', it.auto && 'auto', !it.enabled && 'off', it.pinned && 'pinned')} data-tip={`${it.label}${it.auto ? ' — added automatically' : ''} · ${formatNumber(it.tokens)} tokens${it.truncated ? ' (truncated)' : ''}${it.note ? ' · ' + it.note : ''}`}>
            {!it.auto && <button className={cn('cc-check', it.enabled && 'on')} onClick={() => patch(it.id, { enabled: !it.enabled })} aria-label="Include in context">{it.enabled && <Check size={10} strokeWidth={3.5} />}</button>}
            {it.auto && <Sparkles size={11} className="cc-auto" />}
            <button className="cc-main" onClick={e => setMenu({ el: e.currentTarget, item: it })}><I size={12} /><span className="truncate">{it.label}</span><span className="cc-tok">{formatTokens(it.tokens)}</span></button>
            {it.pinned && <Pin size={10} className="cc-pin" />}
            {!it.auto && <button className="cc-x" onClick={() => remove(it.id)} aria-label="Remove"><X size={11} /></button>}
          </span>
        })}
        {!open && items.length > 6 && <button className="ctx-more" onClick={() => setOpen(true)}>+{items.length - 6} more</button>}
        {open && manual.length > 0 && <button className="ctx-more" onClick={() => save([])}><Eraser size={11} /> Clear added</button>}
      </div>
      {open && <div className="ctx-breakdown">
        <span>System <b>{formatTokens(snap.system)}</b></span><span>History <b>{formatTokens(snap.history)}</b></span><span>Attached <b>{formatTokens(snap.budgetItems)}</b></span>
      </div>}
      {menu && <Popover anchor={menu.el} placement="bottom-start" onClose={() => setMenu(null)} width={250}>
        <div className="menu-title truncate">{menu.item.label}</div>
        {menu.item.path && menu.item.kind !== 'url' && <button className="menu-item" onClick={() => { setMenu(null); void useEditor.getState().openFile(menu.item.path!, { line: menu.item.range?.startLine }) }}><span className="mi-icon"><FileText size={15} /></span><span className="mi-label">Open</span></button>}
        {menu.item.auto
          ? <button className="menu-item" onClick={() => { keep(menu.item); setMenu(null) }}><span className="mi-icon"><Pin size={15} /></span><span className="mi-label">Keep for the whole chat</span></button>
          : <>
            <button className="menu-item" onClick={() => { patch(menu.item.id, { pinned: !menu.item.pinned }); setMenu(null) }}><span className="mi-icon">{menu.item.pinned ? <PinOff size={15} /> : <Pin size={15} />}</span><span className="mi-label">{menu.item.pinned ? 'Unpin' : 'Pin (never trim)'}</span></button>
            <div className="menu-title">Priority when space is tight</div>
            <div className="prio">{([1, 2, 3, 4, 5] as const).map(p => <button key={p} className={cn(menu.item.priority === p && 'on')} onClick={() => { patch(menu.item.id, { priority: p }); setMenu(null) }}>{p}</button>)}</div>
            <div className="menu-sep" />
            <button className="menu-item danger" onClick={() => { remove(menu.item.id); setMenu(null) }}><span className="mi-icon"><X size={15} /></span><span className="mi-label">Remove</span></button>
          </>}
      </Popover>}
    </div>
  )
}
