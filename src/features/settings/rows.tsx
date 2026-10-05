import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '../../lib/util'
import { Switch } from '../../components/ui'

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="set-section">
    <header className="set-head"><div><h2 className="serif">{title}</h2>{description && <p>{description}</p>}</div>{actions}</header>
    {children}
  </section>
}

export function Group({ title, children, hint }: { title?: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="set-group">{title && <div className="set-group-title">{title}</div>}<div className="card set-card">{children}</div>{hint && <div className="set-hint">{hint}</div>}</div>
}

export function Row({ title, description, children, stack, id }: { title: ReactNode; description?: ReactNode; children?: ReactNode; stack?: boolean; id?: string }) {
  return <div className={cn('set-row', stack && 'stack')} id={id}>
    <div className="set-row-main"><div className="set-row-title">{title}</div>{description && <div className="set-row-desc">{description}</div>}</div>
    {children !== undefined && <div className="set-row-ctl">{children}</div>}
  </div>
}

export function ToggleRow({ title, description, value, onChange, disabled }: { title: ReactNode; description?: ReactNode; value: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return <Row title={title} description={description}><Switch on={value} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : undefined} /></Row>
}

/** `blank`: a value of 0 means “not set” – it is shown empty with a placeholder, and clearing the field stores 0. */
export function NumberField({ value, onChange, min, max, step = 1, suffix, width = 84, blank, placeholder }: { value: number; onChange(v: number): void; min?: number; max?: number; step?: number; suffix?: string; width?: number; blank?: boolean; placeholder?: string }) {
  const show = (v: number) => (blank && !v ? '' : String(v))
  const [text, setText] = useState(show(value))
  useEffect(() => { setText(show(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    if (blank && text.trim() === '') { onChange(0); return }
    const n = parseFloat(text)
    if (Number.isFinite(n)) { const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)); onChange(c); setText(String(c)) } else setText(show(value))
  }
  return <span className="row gap6"><input className="input sm" style={{ width }} type="number" value={text} min={min} max={max} step={step} placeholder={placeholder ?? (blank ? '—' : undefined)} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />{suffix && <span className="subtle small">{suffix}</span>}</span>
}

export function TextField({ value, onChange, placeholder, width = 260, mono, password }: { value: string; onChange(v: string): void; placeholder?: string; width?: number | string; mono?: boolean; password?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  return <input className="input sm" style={{ width, fontFamily: mono ? 'var(--font-mono)' : undefined }} type={password ? 'password' : 'text'} value={text} placeholder={placeholder} spellCheck={false} onChange={e => setText(e.target.value)} onBlur={() => { if (text !== value) onChange(text) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

export function TextArea({ value, onChange, placeholder, rows = 4, mono }: { value: string; onChange(v: string): void; placeholder?: string; rows?: number; mono?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  return <textarea className="textarea" rows={rows} style={{ width: '100%', fontFamily: mono ? 'var(--font-mono)' : undefined, fontSize: mono ? 12 : undefined }} value={text} placeholder={placeholder} spellCheck={false} onChange={e => setText(e.target.value)} onBlur={() => { if (text !== value) onChange(text) }} />
}

export function SelectField<T extends string>({ value, options, onChange, width = 170 }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; width?: number }) {
  return <select className="select sm" style={{ width }} value={value} onChange={e => onChange(e.target.value as T)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
}

export function Slider({ value, onChange, min, max, step, format }: { value: number; onChange(v: number): void; min: number; max: number; step: number; format?: (v: number) => string }) {
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  return <span className="row gap8"><input type="range" className="slider" min={min} max={max} step={step} value={v} onChange={e => setV(parseFloat(e.target.value))} onMouseUp={() => onChange(v)} onKeyUp={() => onChange(v)} onTouchEnd={() => onChange(v)} /><span className="small muted" style={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{format ? format(v) : v}</span></span>
}
