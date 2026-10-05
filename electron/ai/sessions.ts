import { promises as fsp, existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, Session, SessionMeta, UsageStats } from '../../shared/ai'
import { dataPath } from '../services/paths'
import { uid } from '../services/storage'
import { settings } from '../services/settings'

export function messageText(m: Message): string {
  return m.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => (p as { text: string }).text).join('\n')
}

export function metaOf(s: Session, running = false): SessionMeta {
  const firstUser = s.messages.find(m => m.role === 'user' && !m.notice)
  return {
    id: s.id, title: s.title, projectRoot: s.projectRoot, createdAt: s.createdAt, updatedAt: s.updatedAt, agent: s.agent,
    messageCount: s.messages.filter(m => !m.notice).length, preview: firstUser ? messageText(firstUser).slice(0, 140) : '', parentId: s.parentId, running
  }
}

class SessionStore {
  private cache = new Map<string, Session>()
  private timers = new Map<string, NodeJS.Timeout>()
  private index = new Map<string, SessionMeta>()
  private loaded = false

  private dir() { const d = dataPath('sessions'); mkdirSync(d, { recursive: true }); return d }
  private file(id: string) { return join(this.dir(), `${id}.json`) }
  private usageFile() { return dataPath('usage-log.jsonl') }

  private ensureIndex(): void {
    if (this.loaded) return
    this.loaded = true
    const idx = dataPath('sessions-index.json')
    try {
      if (existsSync(idx)) { for (const m of JSON.parse(readFileSync(idx, 'utf8')) as SessionMeta[]) this.index.set(m.id, m); return }
    } catch { /* rebuild */ }
    for (const f of readdirSync(this.dir())) {
      if (!f.endsWith('.json')) continue
      try { const s = JSON.parse(readFileSync(join(this.dir(), f), 'utf8')) as Session; this.index.set(s.id, metaOf(s)) } catch { /* skip */ }
    }
  }

  private writeIndex(): void {
    try { const p = dataPath('sessions-index.json'); writeFileSync(p + '.tmp', JSON.stringify([...this.index.values()])); renameSync(p + '.tmp', p) } catch { /* best effort */ }
  }

  create(opts: Partial<Session> & { projectRoot: string | null }): Session {
    this.ensureIndex()
    const now = Date.now()
    const s: Session = {
      id: uid('s-'), title: 'New chat', createdAt: now, updatedAt: now, agent: settings.get().ai.defaultAgent, messages: [], todos: [], context: [],
      usage: { input: 0, output: 0, cost: 0, steps: 0 }, ...opts
    }
    this.cache.set(s.id, s)
    this.index.set(s.id, metaOf(s))
    this.saveNow(s)
    return s
  }

  get(id: string): Session | null {
    const c = this.cache.get(id)
    if (c) return c
    try {
      const s = JSON.parse(readFileSync(this.file(id), 'utf8')) as Session
      this.cache.set(id, s)
      return s
    } catch { return null }
  }

  save(s: Session): void {
    s.updatedAt = Date.now()
    this.index.set(s.id, { ...metaOf(s), running: this.index.get(s.id)?.running })
    const t = this.timers.get(s.id)
    if (t) clearTimeout(t)
    this.timers.set(s.id, setTimeout(() => { this.timers.delete(s.id); this.saveNow(s) }, 600))
  }

  saveNow(s: Session): void {
    const t = this.timers.get(s.id)
    if (t) { clearTimeout(t); this.timers.delete(s.id) }
    try {
      const tmp = this.file(s.id) + '.tmp'
      writeFileSync(tmp, JSON.stringify(s))
      renameSync(tmp, this.file(s.id))
      this.writeIndex()
    } catch (e) { console.error('session save failed', e) }
  }

  flushAll(): void { for (const s of this.cache.values()) if (this.timers.has(s.id)) this.saveNow(s) }

  list(projectRoot?: string | null): SessionMeta[] {
    this.ensureIndex()
    return [...this.index.values()].filter(m => !m.parentId && (projectRoot === undefined || m.projectRoot === projectRoot)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  setRunning(id: string, running: boolean): void { const m = this.index.get(id); if (m) m.running = running }

  async delete(id: string): Promise<void> {
    this.ensureIndex()
    for (const m of [...this.index.values()]) if (m.parentId === id) await this.delete(m.id)
    this.cache.delete(id); this.index.delete(id)
    await fsp.rm(this.file(id), { force: true })
    await fsp.rm(dataPath('snapshots', id), { recursive: true, force: true })
    this.writeIndex()
  }

  fork(id: string, uptoMessageId?: string): Session | null {
    const src = this.get(id)
    if (!src) return null
    let msgs = src.messages
    if (uptoMessageId) { const i = msgs.findIndex(m => m.id === uptoMessageId); if (i >= 0) msgs = msgs.slice(0, i + 1) }
    const copy = this.create({
      projectRoot: src.projectRoot, agent: src.agent, model: src.model, mode: src.mode, reasoning: src.reasoning, title: `${src.title} (fork)`, titled: true,
      messages: JSON.parse(JSON.stringify(msgs)), todos: JSON.parse(JSON.stringify(src.todos)), context: JSON.parse(JSON.stringify(src.context)), forkedFrom: id, compactedUpTo: src.compactedUpTo
    })
    return copy
  }

  logUsage(entry: { ts: number; model: string; input: number; output: number; sessionId: string; kind: 'user' | 'assistant' }): void {
    try { appendFileSync(this.usageFile(), JSON.stringify(entry) + '\n') } catch { /* ignore */ }
  }

  stats(): UsageStats {
    this.ensureIndex()
    const days = new Map<string, number>()
    const hours = new Array(24).fill(0) as number[]
    const models = new Map<string, { tokens: number; messages: number }>()
    let messages = 0, tokens = 0
    try {
      for (const line of readFileSync(this.usageFile(), 'utf8').split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as { ts: number; model: string; input: number; output: number }
          messages++
          tokens += (e.input || 0) + (e.output || 0)
          const d = new Date(e.ts)
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          days.set(key, (days.get(key) ?? 0) + 1)
          hours[d.getHours()]++
          if (e.model) { const m = models.get(e.model) ?? { tokens: 0, messages: 0 }; m.tokens += (e.input || 0) + (e.output || 0); m.messages++; models.set(e.model, m) }
        } catch { /* skip */ }
      }
    } catch { /* no log yet */ }
    const byModel = [...models.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.messages - a.messages)
    const peak = Math.max(...hours)
    return {
      sessions: [...this.index.values()].filter(m => !m.parentId).length, messages, tokens, activeDays: days.size,
      peakHour: peak > 0 ? hours.indexOf(peak) : null, favoriteModel: byModel[0]?.model ?? null,
      daily: [...days.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)), byModel
    }
  }
}

export const sessions = new SessionStore()
