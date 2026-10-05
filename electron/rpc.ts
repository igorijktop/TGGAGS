import { ipcMain } from 'electron'
import { log } from './services/log'

type Fn = (...args: unknown[]) => unknown

function resolvePath(impl: object, path: string): Fn {
  const parts = path.split('.')
  let cur: unknown = impl
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || p.startsWith('_')) throw new Error(`Unknown API method: ${path}`)
    cur = (cur as Record<string, unknown>)[p]
  }
  if (typeof cur !== 'function') throw new Error(`Unknown API method: ${path}`)
  return cur as Fn
}

/** Registers the single `rpc` IPC channel. The renderer sees a typed proxy over the same shape. */
export function registerRpc(impl: object): void {
  ipcMain.handle('rpc', async (_e, path: string, args: unknown[]) => {
    try {
      const fn = resolvePath(impl, path)
      const result = await fn(...(Array.isArray(args) ? args : []))
      return { ok: true, result: result === undefined ? null : result }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (process.env.TGG_DEBUG_RPC) log.error('rpc', `${path}: ${e?.stack ?? e}`)
      return { ok: false, error: { message: e?.message ?? String(err), code: e?.code } }
    }
  })
}
