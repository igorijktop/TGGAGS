import { ProviderError, classifyStatus } from './types'

type FetchFn = typeof fetch
let cached: FetchFn | null = null

/** Uses Electron's net.fetch (system proxy + OS certificate store) when running inside Electron, global fetch otherwise. */
export function getFetch(): FetchFn {
  if (cached) return cached
  try {
    if (process.versions.electron) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { net, app } = require('electron') as typeof import('electron')
      if (app?.isReady?.()) { cached = ((input: string | URL | Request, init?: RequestInit) => net.fetch(input as string, init as never)) as unknown as FetchFn; return cached }
    }
  } catch { /* fall through */ }
  return fetch
}

export const httpFetch: FetchFn = (input, init) => getFetch()(input, init)

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

export function authHeaderless(h: Record<string, string>): Record<string, string> { return h }

/** Parses an error response body into a readable message. */
export async function errorFromResponse(res: Response, provider: string): Promise<ProviderError> {
  let text = ''
  try { text = await res.text() } catch { /* ignore */ }
  let message = text.slice(0, 600)
  try {
    const j = JSON.parse(text)
    message = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail ?? message
    if (typeof message !== 'string') message = JSON.stringify(message)
  } catch { /* plain text */ }
  const retryAfter = Number(res.headers.get('retry-after'))
  const kind = classifyStatus(res.status, message)
  const hint = kind === 'auth' ? ' (check the API key in Settings → Models)' : kind === 'not_found' ? ' (check the base URL and model name)' : ''
  return new ProviderError(`${provider}: ${res.status} ${message || res.statusText}${hint}`, kind, {
    status: res.status, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
  })
}

export function networkError(e: unknown, provider: string, url: string): ProviderError {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  if (err?.name === 'AbortError') return new ProviderError('Request aborted', 'aborted', { retryable: false })
  const code = err?.cause?.code ?? ''
  const detail = err?.cause?.message ?? err?.message ?? String(e)
  let host = url
  try { host = new URL(url).host } catch { /* keep */ }
  const refused = /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(code + detail)
  return new ProviderError(`${provider}: cannot reach ${host} – ${refused ? 'connection refused (is the server running?)' : detail}`, 'network')
}

export interface SseEvent { event?: string; data: string }

/** Incremental Server-Sent-Events parser over a fetch Response body. */
export async function* sseEvents(res: Response, ctl: { touch(): void }): AsyncGenerator<SseEvent> {
  if (!res.body) throw new ProviderError('Empty response body', 'other')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event: string | undefined
  let data: string[] = []
  const flush = (): SseEvent | null => {
    if (!data.length) { event = undefined; return null }
    const out = { event, data: data.join('\n') }
    event = undefined; data = []
    return out
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      ctl.touch()
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + (buf[idx] === '\r' && buf[idx + 1] === '\n' ? 2 : 1))
        if (line === '') { const ev = flush(); if (ev) yield ev; continue }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let v = colon < 0 ? '' : line.slice(colon + 1)
        if (v.startsWith(' ')) v = v.slice(1)
        if (field === 'event') event = v
        else if (field === 'data') data.push(v)
      }
    }
    buf += decoder.decode()
    if (buf.trim()) { for (const line of buf.split(/\r?\n/)) { if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')) } }
    const ev = flush()
    if (ev) yield ev
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

/** Combines a caller signal with an idle timeout; `touch()` resets the idle timer on each received chunk. */
export function makeAbort(signal: AbortSignal | undefined, idleMs: number) {
  const ac = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    if (idleMs > 0) timer = setTimeout(() => { timedOut = true; ac.abort() }, idleMs)
  }
  const onAbort = () => ac.abort()
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }) }
  arm()
  return {
    signal: ac.signal,
    touch: arm,
    get timedOut() { return timedOut },
    done() { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  }
}

/** Splits <think>…</think> blocks out of a streamed text channel (used by local reasoning models). */
export class ThinkSplitter {
  private inThink = false
  private pending = ''
  push(chunk: string): { text: string; reasoning: string } {
    this.pending += chunk
    let text = '', reasoning = ''
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const idx = this.pending.indexOf(tag)
      if (idx >= 0) {
        const before = this.pending.slice(0, idx)
        if (this.inThink) reasoning += before; else text += before
        this.pending = this.pending.slice(idx + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // keep a possible partial tag at the end
      let keep = 0
      for (let k = Math.min(tag.length - 1, this.pending.length); k > 0; k--) {
        if (tag.startsWith(this.pending.slice(this.pending.length - k))) { keep = k; break }
      }
      const emit = this.pending.slice(0, this.pending.length - keep)
      this.pending = this.pending.slice(this.pending.length - keep)
      if (this.inThink) reasoning += emit; else text += emit
      return { text, reasoning }
    }
  }
  flush(): { text: string; reasoning: string } {
    const rest = this.pending
    this.pending = ''
    return this.inThink ? { text: '', reasoning: rest } : { text: rest, reasoning: '' }
  }
}

/** Strict JSON parse for tool arguments. Truncated or malformed input is never repaired – the model must retry. */
export function safeParseJson(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!s.trim()) return { ok: true, value: {} }
  try { return { ok: true, value: JSON.parse(s) } } catch (e) {
    return { ok: false, error: `${(e as Error).message}. The arguments were not valid JSON (they may have been cut off by the output limit).` }
  }
}
