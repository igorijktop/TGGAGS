import clsx, { type ClassValue } from 'clsx'

export const cn = (...a: ClassValue[]) => clsx(a)

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void; flush(): void } {
  let t: ReturnType<typeof setTimeout> | null = null
  let last: A | null = null
  const d = ((...a: A) => { last = a; if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...a) }, ms) }) as ((...a: A) => void) & { cancel(): void; flush(): void }
  d.cancel = () => { if (t) clearTimeout(t); t = null }
  d.flush = () => { if (t && last) { clearTimeout(t); t = null; fn(...last) } }
  return d
}

export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0, t: ReturnType<typeof setTimeout> | null = null, pending: A | null = null
  return (...a: A) => {
    const now = Date.now()
    pending = a
    if (now - last >= ms) { last = now; fn(...a); pending = null }
    else if (!t) t = setTimeout(() => { t = null; last = Date.now(); if (pending) fn(...pending); pending = null }, ms - (now - last))
  }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export const formatNumber = (n: number) => n.toLocaleString('en-US')

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function timeAgo(ts: number | string): string {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts
  const d = Date.now() - t
  if (d < 45_000) return 'just now'
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function formatCost(c: number): string { return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}` }

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p
export const dirname = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i) }
export const joinPath = (a: string, b: string) => (a.endsWith('/') || a.endsWith('\\') ? a : a + (a.includes('\\') && !a.includes('/') ? '\\' : '/')) + b
export const extname = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase() }
export function relativeTo(root: string | null, p: string): string {
  if (!root) return p
  const n = (s: string) => s.replace(/\\/g, '/')
  const r = n(root).replace(/\/$/, ''), q = n(p)
  return q.toLowerCase().startsWith(r.toLowerCase() + '/') ? q.slice(r.length + 1) : q
}
export const toFileUrl = (p: string) => `tgg-file://local/${encodeURIComponent(p)}`

/** Subsequence fuzzy match with scoring; returns matched indices for highlighting. */
export function fuzzy(query: string, text: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] }
  const q = query.toLowerCase(), t = text.toLowerCase()
  const indices: number[] = []
  let ti = 0, score = 0, prev = -2
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    let found = -1
    for (let k = ti; k < t.length; k++) if (t[k] === c) { found = k; break }
    if (found < 0) return null
    indices.push(found)
    score += 1
    if (found === prev + 1) score += 3
    const before = found === 0 ? '/' : t[found - 1]
    if (before === '/' || before === '\\' || before === '-' || before === '_' || before === '.' || before === ' ') score += 4
    if (found === 0) score += 2
    prev = found
    ti = found + 1
  }
  const base = t.lastIndexOf('/') + 1
  if (indices[0] >= base) score += 6
  score -= Math.min(10, (t.length - q.length) * 0.05)
  return { score, indices }
}

export function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const a of arr) (out[key(a)] ??= []).push(a)
  return out
}

// typed through a minimal structural interface so this file also type-checks in the DOM-less node project (unit tests import it)
interface ClipboardHost { navigator?: { clipboard?: { writeText(t: string): Promise<void> } }; document?: { createElement(tag: string): { value: string; select(): void; remove(): void }; body: { appendChild(n: unknown): void }; execCommand(c: string): boolean } }
export async function copyText(text: string): Promise<void> {
  const host = globalThis as unknown as ClipboardHost
  try { await host.navigator!.clipboard!.writeText(text) } catch {
    const d = host.document
    if (!d) return
    const ta = d.createElement('textarea'); ta.value = text; d.body.appendChild(ta); ta.select(); d.execCommand('copy'); ta.remove()
  }
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10)
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
export const isTyping = (t: unknown) => { const e = t as { tagName?: string; isContentEditable?: boolean; closest?(s: string): unknown } | null; return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || !!e.isContentEditable || !!e.closest?.('.monaco-editor, .xterm')) }

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v)
    else out[k] = v
  }
  return out as T
}
