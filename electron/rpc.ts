import { ipcMain } from 'electron'
import { log } from './services/log'

type Fn = (...args: unknown[]) => unknown

function resolvePath(impl: object, path: string): { fn: Fn; self: unknown } {
  const parts = path.split('.')
  let cur: unknown = impl
  let parent: unknown = impl
  for (const p of parts) {
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function') || p.startsWith('_')) throw new Error(`Unknown API method: ${path}`)
    parent = cur
    cur = (cur as Record<string, unknown>)[p]
  }
  if (typeof cur !== 'function') throw new Error(`Unknown API method: ${path}`)
  return { fn: cur as Fn, self: parent }
}

/** Registers the single `rpc` IPC channel. The renderer sees a typed proxy over the same shape. */
export function registerRpc(impl: object): void {
  ipcMain.handle('rpc', async (_e, path: string, args: unknown[]) => {
    try {
      const { fn, self } = resolvePath(impl, path)
      const result = await fn.apply(self, Array.isArray(args) ? args : [])
      return { ok: true, result: result === undefined ? null : result }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (process.env.TGG_DEBUG_RPC) log.error('rpc', `${path}: ${e?.stack ?? e}`)
      return { ok: false, error: { message: e?.message ?? String(err), code: e?.code } }
    }
  })
}
