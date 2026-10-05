import type { Api, EventMap } from '@shared/api'

interface Bridge {
  rpc(path: string, args: unknown[]): Promise<{ ok: true; result: unknown } | { ok: false; error: { message: string; code?: string } }>
  subscribe(l: (channel: string, payload: unknown) => void): () => void
  pathForFile(file: File): string
  platform: string
  arch: string
}

declare global { interface Window { tgg: Bridge } }

export const bridge: Bridge = window.tgg
export const platform = bridge?.platform ?? 'linux'
export const isMac = platform === 'darwin'
export const isWin = platform === 'win32'

export class RpcError extends Error {
  code?: string
  constructor(message: string, code?: string) { super(message); this.code = code }
}

async function invoke(path: string, args: unknown[]): Promise<unknown> {
  const res = await bridge.rpc(path, args)
  if (!res.ok) throw new RpcError(res.error.message, res.error.code)
  return res.result
}

function proxy(path: string[]): unknown {
  const fn = function () { /* proxy target */ }
  return new Proxy(fn, {
    get(_t, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined
      return proxy([...path, key])
    },
    apply(_t, _this, args) { return invoke(path.join('.'), args) }
  })
}

/** Fully typed proxy over the main-process API (see shared/api.ts). */
export const api = proxy([]) as Api

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void

const handlers = new Map<string, Set<(p: unknown) => void>>()
let wired = false
function wire() {
  if (wired || !bridge) return
  wired = true
  bridge.subscribe((channel, payload) => { handlers.get(channel)?.forEach(h => h(payload)) })
}

export function onEvent<K extends keyof EventMap>(channel: K, handler: Handler<K>): () => void
export function onEvent(channel: string, handler: (p: any) => void): () => void
export function onEvent(channel: string, handler: (p: any) => void): () => void {
  wire()
  let set = handlers.get(channel)
  if (!set) { set = new Set(); handlers.set(channel, set) }
  set.add(handler)
  return () => { set!.delete(handler) }
}
