import picomatch from 'picomatch'
import { isAbsolute, relative, sep } from 'node:path'
import type { PermissionRequest, PermissionReply } from '../../shared/ai'
import { defaultPermissionRules, type AgentConfig, type PermissionAction, type PermissionCategory, type PermissionMode, type PermissionRule, type Settings } from '../../shared/settings'
import { settings } from '../services/settings'
import { uid } from '../services/storage'
import { insideRoot } from './tools/util'
import type { PermissionCheck } from './tools/types'

const win = process.platform === 'win32'

const normPath = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')

/** Project-relative POSIX path when inside the root, otherwise the absolute path without a leading slash/drive colon. */
export function pathForMatch(root: string, abs: string): string {
  if (root && insideRoot(root, abs)) return normPath(relative(root, abs)) || '.'
  return normPath(abs).replace(/^\/+/, '').replace(/^([a-zA-Z]):/, '$1')
}

const globCache = new Map<string, (s: string) => boolean>()
function globMatcher(pattern: string): (s: string) => boolean {
  let m = globCache.get(pattern)
  if (!m) {
    const pat = normPath(pattern).replace(/^\/+/, '').replace(/^([a-zA-Z]):/, '$1')
    const full = picomatch(pat, { dot: true, nocase: win })
    const any = pat.includes('/') ? null : picomatch(`**/${pat}`, { dot: true, nocase: win })
    m = (s: string) => full(s) || (any ? any(s) : false) || (pat.endsWith('/**') ? false : picomatch(`${pat}/**`, { dot: true, nocase: win })(s))
    globCache.set(pattern, m)
  }
  return m
}

function wildcard(pattern: string, text: string): boolean {
  const re = '^' + pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*') + '$'
  return new RegExp(re, 'i').test(text.trim())
}

function ruleMatches(rule: PermissionRule, input: { toolName: string; category: PermissionCategory; resource: string; isPath: boolean; agentId: string; providerId?: string }): boolean {
  if (rule.tool !== '*' && rule.tool !== input.category && rule.tool !== input.toolName) return false
  if (rule.agent && rule.agent !== input.agentId) return false
  if (rule.provider && rule.provider !== input.providerId) return false
  if (!rule.pattern) return true
  if (input.isPath) return globMatcher(rule.pattern)(input.resource)
  if (input.category === 'web') {
    const p = rule.pattern.toLowerCase().replace(/^https?:\/\//, '')
    const host = input.resource.toLowerCase()
    return wildcard(p, host) || host.endsWith('.' + p)
  }
  return wildcard(rule.pattern, input.resource)
}

export interface Evaluation { action: PermissionAction; rule?: PermissionRule; reason?: string }

export function evaluate(
  rules: PermissionRule[], grants: PermissionRule[],
  input: { toolName: string; category: PermissionCategory; resource: string; isPath: boolean; agentId: string; providerId?: string }
): Evaluation {
  let action: PermissionAction = 'ask'
  let hit: PermissionRule | undefined
  for (const r of rules) if (ruleMatches(r, input)) { action = r.action; hit = r }
  if (action === 'ask') for (const g of grants) if (ruleMatches(g, input)) return { action: 'allow', rule: g }
  return { action, rule: hit, reason: hit?.note }
}

export function applyMode(mode: PermissionMode, e: Evaluation, category: PermissionCategory, insideProject: boolean): Evaluation {
  if (e.action === 'deny') return e
  switch (mode) {
    case 'plan':
      if (category === 'edit') return { action: 'deny', reason: 'Plan mode is read-only. Switch the mode to Auto-edit or Ask to make changes.' }
      if (e.action === 'ask') return { action: 'deny', reason: 'Plan mode is read-only; this action needs approval and was blocked. Describe the intended change in your plan instead.' }
      return e
    case 'auto-edit':
      if (e.action === 'ask' && category === 'edit' && insideProject) return { action: 'allow', rule: e.rule }
      return e
    case 'yolo':
      return e.action === 'ask' ? { action: 'allow', rule: e.rule } : e
    default:
      return e
  }
}

export function suggestRules(check: PermissionCheck, toolName: string, root: string): PermissionRequest['suggestions'] {
  const out: PermissionRequest['suggestions'] = []
  const r0 = check.resources[0] ?? ''
  const cat = check.category
  const base = { action: 'allow' as const }
  if (check.isPath) {
    const rel = pathForMatch(root, r0)
    const dirParts = rel.split('/')
    out.push({ label: `This file only (${rel})`, rule: { ...base, tool: cat, pattern: rel } })
    if (dirParts.length > 1) out.push({ label: `Anything in ${dirParts.slice(0, -1).join('/')}/`, rule: { ...base, tool: cat, pattern: dirParts.slice(0, -1).join('/') + '/**' } })
    if (insideRoot(root, isAbsolute(r0) ? r0 : root)) out.push({ label: cat === 'edit' ? 'All edits in this project' : 'Everything in this project', rule: { ...base, tool: cat, pattern: '**' } })
  } else if (cat === 'shell' || cat === 'git') {
    const toks = r0.split(/\s+/).filter(Boolean)
    out.push({ label: `Exactly "${r0.length > 60 ? r0.slice(0, 60) + '…' : r0}"`, rule: { ...base, tool: cat, pattern: r0 } })
    if (toks.length > 2) out.push({ label: `"${toks.slice(0, 2).join(' ')} …"`, rule: { ...base, tool: cat, pattern: `${toks.slice(0, 2).join(' ')}*` } })
    if (toks.length > 1) out.push({ label: `Any "${toks[0]} …" command`, rule: { ...base, tool: cat, pattern: `${toks[0]} *` } })
  } else if (cat === 'web') {
    out.push({ label: `Any request to ${r0}`, rule: { ...base, tool: 'web', pattern: r0 } })
    out.push({ label: 'All websites', rule: { ...base, tool: 'web' } })
  } else if (cat === 'mcp') {
    out.push({ label: `This tool (${toolName})`, rule: { ...base, tool: toolName } })
    const server = toolName.split('__')[1]
    if (server) out.push({ label: `Every tool of "${server}"`, rule: { ...base, tool: 'mcp', pattern: `mcp__${server}__*` } })
  } else {
    out.push({ label: `Always allow ${cat}`, rule: { ...base, tool: toolName } })
  }
  return out
}

export interface AuthContext {
  sessionId: string
  agent: AgentConfig
  toolName: string
  mode: PermissionMode
  root: string
  signal: AbortSignal
  providerId?: string
  settings: Settings
}

export type AuthResult = { allowed: true } | { allowed: false; userDenied: boolean; reason: string }

interface Pending { request: PermissionRequest; resolve(r: PermissionReply | null): void; check: PermissionCheck; ctx: AuthContext }

export class PermissionManager {
  private pending = new Map<string, Pending>()
  private grants = new Map<string, PermissionRule[]>()
  constructor(private emitEvent: (e: import('../../shared/ai').AiEvent) => void) {}

  rulesFor(s: Settings, agent: AgentConfig): PermissionRule[] {
    return [...defaultPermissionRules(), ...s.permissions.rules, ...(agent.permissions ?? [])]
  }

  sessionGrants(sessionId: string): PermissionRule[] { return this.grants.get(sessionId) ?? [] }
  clearSession(sessionId: string): void { this.grants.delete(sessionId); this.cancelSession(sessionId) }

  evaluateCheck(check: PermissionCheck, ctx: AuthContext): { action: PermissionAction; reason?: string; asks: string[] } {
    const rules = this.rulesFor(ctx.settings, ctx.agent)
    const grants = this.sessionGrants(ctx.sessionId)
    let worst: PermissionAction = 'allow'
    let reason: string | undefined
    const asks: string[] = []
    const rank = { allow: 0, ask: 1, deny: 2 }
    const consider = (e: Evaluation, resource: string, insideProject: boolean, category: PermissionCategory) => {
      let ev = applyMode(ctx.mode, e, category, insideProject)
      if (ev.action === 'allow' && check.requireAsk && category === 'shell' && ctx.mode !== 'yolo') ev = { action: 'ask', reason: 'Command contains redirection or substitution' }
      if (rank[ev.action] > rank[worst]) { worst = ev.action; reason = ev.reason }
      if (ev.action === 'ask') asks.push(resource)
      if (ev.action === 'deny' && !reason) reason = ev.reason
    }
    for (const raw of check.resources) {
      const inside = check.isPath ? insideRoot(ctx.root, raw) : true
      const resource = check.isPath ? pathForMatch(ctx.root, raw) : raw
      const base = { toolName: check.toolName ?? ctx.toolName, agentId: ctx.agent.id, providerId: ctx.providerId, isPath: !!check.isPath }
      consider(evaluate(rules, grants, { ...base, category: check.category, resource }), raw, inside, check.category)
      if (check.isPath && !inside && (check.category === 'read' || check.category === 'edit' || check.category === 'external_dir')) {
        if (check.category !== 'external_dir') consider(evaluate(rules, grants, { ...base, category: 'external_dir', resource }), raw, false, 'external_dir')
      }
    }
    return { action: worst, reason, asks: [...new Set(asks)] }
  }

  async authorize(check: PermissionCheck, ctx: AuthContext): Promise<AuthResult> {
    const ev = this.evaluateCheck(check, ctx)
    if (ev.action === 'allow') return { allowed: true }
    if (ev.action === 'deny') return { allowed: false, userDenied: false, reason: ev.reason ?? `Blocked by a permission rule (${check.category}: ${check.resources[0]}).` }

    const request: PermissionRequest = {
      id: uid('perm-'), sessionId: ctx.sessionId, agent: ctx.agent.id, tool: ctx.toolName, category: check.category,
      title: check.title, detail: check.detail, resources: ev.asks.length ? ev.asks : check.resources, preview: check.preview,
      suggestions: suggestRules({ ...check, resources: ev.asks.length ? ev.asks : check.resources }, check.toolName ?? ctx.toolName, ctx.root), ts: Date.now()
    }
    const reply = await new Promise<PermissionReply | null>(resolve => {
      this.pending.set(request.id, { request, resolve, check, ctx })
      const onAbort = () => { if (this.pending.delete(request.id)) { this.emitEvent({ type: 'permission_resolved', id: request.id, sessionId: ctx.sessionId }); resolve(null) } }
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true })
      this.emitEvent({ type: 'permission_request', request })
    })
    if (!reply) return { allowed: false, userDenied: true, reason: 'The request was cancelled.' }
    if (reply.decision === 'deny') return { allowed: false, userDenied: true, reason: reply.feedback ? `The user denied this action and said: ${reply.feedback}` : 'The user denied this action. Do not retry the same action; ask what they would like instead or choose a different approach.' }
    if (reply.decision === 'session' || reply.decision === 'always') {
      const rules: Omit<PermissionRule, 'id'>[] = reply.rule ? [reply.rule] : request.resources.map(r => ({ tool: check.category, pattern: check.isPath ? pathForMatch(ctx.root, r) : r, action: 'allow' as const }))
      const full = rules.map(r => ({ ...r, id: uid('rule-'), action: 'allow' as const }))
      if (reply.decision === 'session') this.grants.set(ctx.sessionId, [...this.sessionGrants(ctx.sessionId), ...full])
      else settings.update({ permissions: { rules: [...settings.get().permissions.rules, ...full] } })
    }
    return { allowed: true }
  }

  reply(r: PermissionReply): void {
    const p = this.pending.get(r.id)
    if (!p) return
    this.pending.delete(r.id)
    this.emitEvent({ type: 'permission_resolved', id: r.id, sessionId: p.request.sessionId })
    p.resolve(r)
  }

  cancelSession(sessionId: string): void {
    for (const [id, p] of [...this.pending]) if (p.request.sessionId === sessionId) { this.pending.delete(id); this.emitEvent({ type: 'permission_resolved', id, sessionId }); p.resolve(null) }
  }

  pendingRequests(): PermissionRequest[] { return [...this.pending.values()].map(p => p.request) }
}
