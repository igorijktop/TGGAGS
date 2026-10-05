import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent as RMouseEvent, type ReactNode } from 'react'
import { Check, ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { cn, clamp } from '../lib/util'
import { closeDialog, useUi, type MenuEntry } from '../stores/ui'

// ───────────── basic controls ─────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; tip?: string; kbd?: string }
export function Button({ variant = 'secondary', size = 'md', icon: Icon, className, children, tip, kbd, ...rest }: BtnProps) {
  return <button {...rest} data-tip={tip} data-kbd={kbd} className={cn('btn', variant, size !== 'md' && size, className)}>{Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} />}{children}</button>
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; tip?: string; kbd?: string; size?: 'sm' | 'md' | 'lg'; active?: boolean; iconSize?: number; dot?: boolean }
export function IconButton({ icon: Icon, tip, kbd, size = 'md', active, className, iconSize, dot, ...rest }: IconBtnProps) {
  return <button {...rest} data-tip={tip} data-kbd={kbd} aria-label={tip} className={cn('icon-btn', size !== 'md' && size, active && 'active', className)}><Icon size={iconSize ?? (size === 'sm' ? 14 : size === 'lg' ? 18 : 16)} strokeWidth={1.9} />{dot && <span className="dot" />}</button>
}

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange(v: boolean): void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={cn('switch', on && 'on')} onClick={() => onChange(!on)} />
}

export function Checkbox({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label?: ReactNode }) {
  return <button type="button" className="row gap8" style={{ cursor: 'pointer' }} onClick={() => onChange(!on)}><span className={cn('checkbox', on && 'on')}>{on && <Check size={11} strokeWidth={3.5} />}</span>{label}</button>
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange(v: T): void }) {
  return <div className="segmented">{options.map(o => <button key={o.value} data-tip={o.tip} className={cn(o.value === value && 'on')} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>
}

export function Field({ label, hint, children, row }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; row?: boolean }) {
  return <div className={cn('field', row && 'row gap8')}>{label && <label>{label}</label>}{children}{hint && <div className="field-hint">{hint}</div>}</div>
}

export const Spinner = ({ size = 14 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} />
export const Dots = () => <span className="dots"><i /><i /><i /></span>
export const Badge = ({ kind, children, title }: { kind?: 'accent' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode; title?: string }) => <span title={title} className={cn('badge', kind)}>{children}</span>
export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>

export function EmptyState({ icon: Icon, title, text, children }: { icon?: LucideIcon; title: string; text?: ReactNode; children?: ReactNode }) {
  return <div className="empty fade-in">{Icon && <div className="e-icon"><Icon size={22} strokeWidth={1.6} /></div>}<h3>{title}</h3>{text && <p>{text}</p>}{children}</div>
}

export function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>
  const set = new Set(indices)
  const out: ReactNode[] = []
  let buf = '', hl = false
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i)
    if (h !== hl && buf) { out.push(hl ? <span key={i} className="hl-match">{buf}</span> : buf); buf = '' }
    hl = h; buf += text[i]
  }
  if (buf) out.push(hl ? <span key="e" className="hl-match">{buf}</span> : buf)
  return <>{out}</>
}

// ───────────── popover ─────────────
export type Anchor = HTMLElement | DOMRect | { x: number; y: number }
const rectOf = (a: Anchor): DOMRect => a instanceof HTMLElement ? a.getBoundingClientRect() : 'width' in a ? a : new DOMRect(a.x, a.y, 0, 0)

export function Popover({ anchor, onClose, placement = 'bottom-start', children, className, style, width, matchWidth }: { anchor: Anchor; onClose(): void; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start'; children: ReactNode; className?: string; style?: CSSProperties; width?: number; matchWidth?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = rectOf(anchor)
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 6
    let left = placement.endsWith('end') ? r.right - w : r.left
    let top = placement.startsWith('top') ? r.top - h - gap : r.bottom + gap
    if (placement === 'right-start') { left = r.right + 2; top = r.top - 5 }
    if (placement === 'left-start') { left = r.left - w - 2; top = r.top - 5 }
    if (placement.startsWith('bottom') && top + h > vh - 8 && r.top - h - gap > 8) top = r.top - h - gap
    if (placement.startsWith('top') && top < 8 && r.bottom + h + gap < vh) top = r.bottom + gap
    if (placement === 'right-start' && left + w > vw - 8) left = r.left - w - 2
    setPos({ left: clamp(left, 8, Math.max(8, vw - w - 8)), top: clamp(top, 8, Math.max(8, vh - h - 8)) })
  }, [anchor, placement, children])
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const t = setTimeout(() => document.addEventListener('mousedown', down, true), 0)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose) }
  }, [onClose])
  const aw = matchWidth && !(anchor as { x?: number }).x ? rectOf(anchor).width : undefined
  return createPortal(<div ref={ref} className={cn('popover', className)} style={{ ...(pos ?? { left: -9999, top: -9999 }), ...(width ? { width } : {}), ...(aw ? { minWidth: aw } : {}), ...style }} onContextMenu={e => e.preventDefault()}>{children}</div>, document.body)
}

export function MenuList({ items, onClose }: { items: MenuEntry[]; onClose(): void }) {
  const [sub, setSub] = useState<{ el: HTMLElement; items: MenuEntry[] } | null>(null)
  return <>{items.map((it, i) => {
    if (it.separator) return <div key={i} className="menu-sep" />
    if (it.title && !it.label) return <div key={i} className="menu-title">{it.title}</div>
    const Icon = it.icon
    return <button key={i} className={cn('menu-item', it.disabled && 'disabled', it.danger && 'danger', sub?.items === it.children && 'hl')} disabled={it.disabled}
      onMouseEnter={e => { if (it.children) setSub({ el: e.currentTarget, items: it.children }); else setSub(null) }}
      onClick={() => { if (it.children) return; onClose(); it.onClick?.() }}>
      {it.checked !== undefined ? <span className="mi-check">{it.checked && <Check size={14} />}</span> : <span className="mi-icon">{Icon && <Icon size={15} strokeWidth={1.8} />}</span>}
      <span className="mi-label truncate">{it.label}</span>
      {it.hint && <span className="mi-hint">{it.hint}</span>}
      {it.children && <ChevronRight size={14} className="subtle" />}
    </button>
  })}{sub && <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)}><MenuList items={sub.items} onClose={onClose} /></Popover>}</>
}

export function Menu({ anchor, items, onClose, placement }: { anchor: Anchor; items: MenuEntry[]; onClose(): void; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' }) {
  return <Popover anchor={anchor} onClose={onClose} placement={placement}><MenuList items={items} onClose={onClose} /></Popover>
}

/** Button that opens a menu below itself. */
export function MenuButton({ items, children, icon, className, tip, variant = 'ghost', size, placement }: { items: MenuEntry[] | (() => MenuEntry[]); children?: ReactNode; icon?: LucideIcon; className?: string; tip?: string; variant?: BtnProps['variant']; size?: 'sm' | 'md' | 'lg'; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  return <>
    {children === undefined && icon
      ? <IconButton icon={icon} tip={tip} className={className} active={!!el} onClick={e => setEl(el ? null : e.currentTarget)} size={size} />
      : <Button variant={variant} icon={icon} size={size} className={className} tip={tip} onClick={e => setEl(el ? null : e.currentTarget)}>{children}</Button>}
    {el && <Menu anchor={el} placement={placement} items={typeof items === 'function' ? items() : items} onClose={() => setEl(null)} />}
  </>
}

export function ContextMenuHost() {
  const cm = useUi(s => s.contextMenu)
  const close = useUi(s => s.closeContextMenu)
  if (!cm) return null
  return <Popover anchor={{ x: cm.x, y: cm.y }} onClose={close}><MenuList items={cm.items} onClose={close} /></Popover>
}

export function useContextMenu() {
  const open = useUi(s => s.openContextMenu)
  return useCallback((e: RMouseEvent, items: MenuEntry[]) => { e.preventDefault(); e.stopPropagation(); open(e.clientX, e.clientY, items) }, [open])
}

// ───────────── tooltips (event-delegated via data-tip) ─────────────
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let current: HTMLElement | null = null
    const hide = () => { if (timer) clearTimeout(timer); timer = null; current = null; setTip(null) }
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
      if (el === current) return
      hide()
      if (!el) return
      current = el
      timer = setTimeout(() => {
        const text = el.dataset.tip
        if (!text || !el.isConnected) return
        const r = el.getBoundingClientRect()
        const below = r.top < 60 || (el.dataset.tipPos === 'below')
        setTip({ text, kbd: el.dataset.kbd, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below })
      }, 450)
    }
    document.addEventListener('mouseover', over)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('mousedown', hide, true); document.removeEventListener('keydown', hide, true) }
  }, [])
  if (!tip) return null
  return createPortal(<div className="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}>{tip.text}{tip.kbd && <span className="kbd">{tip.kbd}</span>}</div>, document.body)
}

// ───────────── dialogs & toasts ─────────────
function PromptBody({ id, d }: { id: string; d: ReturnType<typeof useUi.getState>['dialogs'][number] }) {
  const [v, setV] = useState(d.initial ?? '')
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const submit = () => { const e = d.validate?.(v) ?? null; if (e) { setErr(e); return } closeDialog(id, v) }
  return <>
    <div className="dialog-body">{d.message && <div style={{ marginBottom: 10 }}>{d.message}</div>}
      <input ref={ref} className="input" value={v} placeholder={d.placeholder} onChange={e => { setV(e.target.value); setErr(null) }} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      {err && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{err}</div>}
    </div>
    <div className="dialog-foot"><Button variant="ghost" onClick={() => closeDialog(id, null)}>{d.cancelLabel ?? 'Cancel'}</Button><Button variant="primary" onClick={submit}>{d.confirmLabel ?? 'OK'}</Button></div>
  </>
}

export function DialogHost() {
  const dialogs = useUi(s => s.dialogs)
  const d = dialogs[dialogs.length - 1]
  useEffect(() => {
    if (!d) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined) }
      if (e.key === 'Enter' && (d.kind === 'confirm' || d.kind === 'alert') && !(e.target as HTMLElement).closest('button')) { closeDialog(d.id, d.kind === 'confirm' ? true : undefined) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [d])
  if (!d) return null
  return createPortal(<div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined) }}>
    <div className={cn('dialog', d.wide && 'wide')} role="dialog" aria-modal="true" aria-label={d.title}>
      <div className="dialog-head"><h2>{d.title}</h2><IconButton icon={X} tip="Close" onClick={() => closeDialog(d.id, d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined)} /></div>
      {d.kind === 'prompt' ? <PromptBody id={d.id} d={d} /> : d.kind === 'custom' ? <div className="dialog-body" style={{ color: 'var(--fg)' }}>{d.render!(v => closeDialog(d.id, v))}</div> : <>
        <div className="dialog-body">{d.message}</div>
        <div className="dialog-foot">
          {d.kind === 'confirm' && <Button variant="ghost" onClick={() => closeDialog(d.id, false)}>{d.cancelLabel ?? 'Cancel'}</Button>}
          <Button variant={d.danger ? 'danger' : 'primary'} autoFocus onClick={() => closeDialog(d.id, d.kind === 'confirm' ? true : undefined)}>{d.confirmLabel ?? 'OK'}</Button>
        </div></>}
    </div>
  </div>, document.body)
}

export function ToastHost() {
  const toasts = useUi(s => s.toasts)
  const dismiss = useUi(s => s.dismissToast)
  const Icon = { success: CircleCheck, error: CircleAlert, warn: TriangleAlert, info: Info }
  return <div className="toasts">{toasts.map(t => { const I = Icon[t.kind]; return <div key={t.id} className={cn('toast', t.kind)}><I size={16} className="t-icon" /><div className="t-msg">{t.message}{t.action && <> <button className="link-btn" onClick={() => { t.action!.run(); dismiss(t.id) }}>{t.action.label}</button></>}</div><IconButton icon={X} size="sm" onClick={() => dismiss(t.id)} /></div> })}</div>
}

// ───────────── resizer ─────────────
export function Resizer({ dir, onDrag, onCommit, className }: { dir: 'v' | 'h'; onDrag(delta: number): void; onCommit?(): void; className?: string }) {
  const [drag, setDrag] = useState(false)
  const start = (e: RMouseEvent) => {
    e.preventDefault()
    setDrag(true)
    let last = dir === 'v' ? e.clientX : e.clientY
    const move = (ev: MouseEvent) => { const p = dir === 'v' ? ev.clientX : ev.clientY; onDrag(p - last); last = p }
    const up = () => { setDrag(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; onCommit?.() }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    document.body.style.cursor = dir === 'v' ? 'col-resize' : 'row-resize'; document.body.style.userSelect = 'none'
  }
  return <div className={cn('resizer', dir, drag && 'dragging', className)} onMouseDown={start} />
}

export function Collapsible({ title, children, defaultOpen = true, actions, count, storageKey }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; count?: number; storageKey?: string }) {
  const [open, setOpen] = useState(() => { try { const v = storageKey ? localStorage.getItem('c:' + storageKey) : null; return v === null ? defaultOpen : v === '1' } catch { return defaultOpen } })
  const toggle = () => { setOpen(!open); try { if (storageKey) localStorage.setItem('c:' + storageKey, open ? '0' : '1') } catch { /* ignore */ } }
  return <div className="collapsible">
    <div className="coll-head" onClick={toggle}><ChevronRight size={14} className={cn('coll-chev', open && 'open')} /><span className="section-title grow truncate">{title}</span>{count !== undefined && <span className="badge">{count}</span>}<span className="row gap4" onClick={e => e.stopPropagation()}>{actions}</span></div>
    {open && <div className="coll-body">{children}</div>}
  </div>
}
