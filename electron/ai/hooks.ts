import { spawn } from 'node:child_process'
import picomatch from 'picomatch'
import type { HookEvent } from '../../shared/settings'
import { settings } from '../services/settings'
import { defaultShell, killTree } from '../services/proc'
import { log } from '../services/log'

export interface HookPayload { event: HookEvent; sessionId?: string; tool?: string; input?: unknown; output?: string; error?: string; cwd?: string; path?: string; agent?: string }
export type HookResult = { deny?: string } | void
type Listener = (p: HookPayload) => Promise<HookResult> | HookResult

const listeners = new Map<HookEvent, Set<Listener>>()

/** Programmatic hooks used by plugins. Returns an unsubscribe function. */
export function onHook(event: HookEvent, fn: Listener): () => void {
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  set.add(fn)
  return () => set!.delete(fn)
}

/** Runs configured shell hooks and plugin hooks. Blocking hooks that fail deny the action. */
export async function runHooks(payload: HookPayload, root: string | null): Promise<{ denied?: string }> {
  for (const l of listeners.get(payload.event) ?? []) {
    try { const r = await l(payload); if (r && r.deny) return { denied: r.deny } } catch (e) { log.warn('hooks', `plugin hook failed: ${(e as Error).message}`) }
  }
  const hooks = settings.effective(root).hooks.filter(h => h.enabled && h.event === payload.event)
  for (const h of hooks) {
    if (h.match && payload.tool && !picomatch(h.match, { nocase: true })(payload.tool)) continue
    if (h.match && !payload.tool && payload.event.startsWith('tool.')) continue
    const sh = defaultShell(settings.get().terminal.shell)
    const res = await new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(sh.path, sh.args(h.command), { cwd: root ?? undefined, windowsHide: true, env: { ...process.env, TGG_HOOK_EVENT: payload.event }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      const timer = setTimeout(() => killTree(child), h.timeoutMs ?? 10_000)
      child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
      child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out: 'failed to start' }) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(JSON.stringify(payload))
    })
    if (res.code !== 0) {
      log.warn('hooks', `hook "${h.command}" exited ${res.code}: ${res.out.slice(0, 300)}`)
      if (h.blocking) return { denied: res.out.trim().slice(0, 500) || `Blocked by hook: ${h.command}` }
    }
  }
  return {}
}
