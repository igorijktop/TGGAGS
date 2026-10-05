import { create } from 'zustand'
import type { AiEvent, ContextItem, ContextSnapshot, FileChange, ImageData, Mention, Message, PermissionRequest, QuestionRequest, RunStatus, SendRequest, Session, SessionMeta, Todo } from '@shared/ai'
import type { AgentConfig, ModelRef, PermissionMode, ReasoningEffort } from '@shared/settings'
import { api, onEvent } from '../lib/api'
import { getSettings, useSettings } from './settings'
import { gatherEditorContext } from '../lib/editor-context'
import { toast } from './ui'

export interface Draft { text: string; images: ImageData[]; mentions: Mention[] }
interface Composer { agent: string; mode: PermissionMode; reasoning: ReasoningEffort; model: ModelRef | null }

interface AiState {
  sessions: SessionMeta[]
  children: Record<string, SessionMeta[]>
  active: string | null
  data: Record<string, Session>
  running: Record<string, boolean>
  status: Record<string, { status: RunStatus; detail?: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  changes: Record<string, FileChange[]>
  context: Record<string, ContextSnapshot>
  errors: Record<string, string | undefined>
  queue: Record<string, SendRequest[]>
  drafts: Record<string, Draft>
  agents: AgentConfig[]
  composer: Composer
  usage: Record<string, Session['usage']>
  init(): Promise<void>
  loadSessions(): Promise<void>
  loadAgents(): Promise<void>
  open(id: string | null): Promise<void>
  newChat(): Promise<void>
  ensureSession(id: string): Promise<Session | null>
  send(text: string, o?: { images?: ImageData[]; mentions?: Mention[]; agent?: string; sessionId?: string }): Promise<void>
  abort(id?: string): Promise<void>
  setComposer(p: Partial<Composer>): void
  setDraft(key: string, d: Partial<Draft>): void
  removeSession(id: string): Promise<void>
  addContext(item: ContextItem): Promise<void>
  setContextItems(items: ContextItem[]): Promise<void>
  dismissError(id: string): void
  todos(id: string | null): Todo[]
}

const draftKey = (id: string | null) => id ?? 'new'

function updateMessage(data: Record<string, Session>, sid: string, mid: string, fn: (m: Message) => Message): Record<string, Session> {
  const s = data[sid]
  if (!s) return data
  const i = s.messages.findIndex(m => m.id === mid)
  if (i < 0) return data
  const messages = s.messages.slice()
  messages[i] = fn(messages[i])
  return { ...data, [sid]: { ...s, messages } }
}

function upsertMessage(data: Record<string, Session>, sid: string, msg: Message): Record<string, Session> {
  const s = data[sid]
  if (!s) return data
  const i = s.messages.findIndex(m => m.id === msg.id)
  const messages = s.messages.slice()
  if (i >= 0) messages[i] = msg; else messages.push(msg)
  return { ...data, [sid]: { ...s, messages } }
}

export const useAi = create<AiState>((set, get) => ({
  sessions: [], children: {}, active: null, data: {}, running: {}, status: {}, permissions: [], questions: [], changes: {}, context: {}, errors: {}, queue: {}, drafts: {}, agents: [], usage: {},
  composer: { agent: 'build', mode: 'auto-edit', reasoning: 'medium', model: null },

  async init() {
    const s = getSettings()
    set({ composer: { agent: s.ai.defaultAgent, mode: s.ai.permissionMode, reasoning: s.ai.reasoning, model: s.ai.defaultModel } })
    void get().loadAgents()
    onEvent('ai:event', e => handle(e, set, get))
    const p = await api.ai.pending().catch(() => ({ permissions: [], questions: [] }))
    set({ permissions: p.permissions, questions: p.questions })
    const running = await api.ai.running().catch(() => [] as string[])
    set({ running: Object.fromEntries(running.map(r => [r, true])) })
    // keep the composer defaults in sync when settings change from the settings page
    let last = JSON.stringify([s.ai.defaultAgent, s.ai.permissionMode, s.ai.reasoning, s.ai.defaultModel])
    useSettings.subscribe(st => {
      const k = JSON.stringify([st.settings.ai.defaultAgent, st.settings.ai.permissionMode, st.settings.ai.reasoning, st.settings.ai.defaultModel])
      if (k !== last) { last = k; if (!get().active) set({ composer: { agent: st.settings.ai.defaultAgent, mode: st.settings.ai.permissionMode, reasoning: st.settings.ai.reasoning, model: st.settings.ai.defaultModel } }) }
    })
  },

  async loadSessions() {
    const list = await api.ai.sessions.list(true).catch(() => [])
    set({ sessions: list })
  },
  async loadAgents() { set({ agents: await api.agents.list().catch(() => []) }) },

  async ensureSession(id) {
    const have = get().data[id]
    if (have && (have.messages.length || get().running[id])) return have
    const s = await api.ai.sessions.get(id)
    if (s) set(st => ({ data: { ...st.data, [id]: s }, usage: { ...st.usage, [id]: s.usage } }))
    return s
  },

  async open(id) {
    if (!id) { set({ active: null }); return }
    const s = await get().ensureSession(id)
    if (!s) return
    set(st => ({
      active: id,
      composer: { agent: s.agent, mode: s.mode ?? getSettings().ai.permissionMode, reasoning: s.reasoning ?? getSettings().ai.reasoning, model: s.model ?? getSettings().ai.defaultModel },
      context: st.context
    }))
    void api.ai.context.get(id).then(c => c && set(st => ({ context: { ...st.context, [id]: c } })))
    void api.ai.changes.list(id).then(c => set(st => ({ changes: { ...st.changes, [id]: c } })))
    try { const root = window.localStorage; root.setItem('ai:last', id) } catch { /* ignore */ }
  },

  async newChat() {
    const st = getSettings()
    set({ active: null, composer: { agent: st.ai.defaultAgent, mode: st.ai.permissionMode, reasoning: st.ai.reasoning, model: st.ai.defaultModel } })
  },

  async send(text, o = {}) {
    const st = get()
    const sid = o.sessionId ?? st.active ?? undefined
    const c = st.composer
    const key = draftKey(sid ?? null)
    const editor = await gatherEditorContext()
    const req: SendRequest = { sessionId: sid, text, images: o.images, mentions: o.mentions, agent: o.agent ?? c.agent, model: c.model, reasoning: c.reasoning, mode: c.mode, editor }
    if (sid && st.running[sid]) { set(s => ({ queue: { ...s.queue, [sid]: [...(s.queue[sid] ?? []), req] } })); return }
    set(s => ({ drafts: { ...s.drafts, [key]: { text: '', images: [], mentions: [] } } }))
    try {
      const r = await api.ai.send(req)
      set(s => ({ active: s.active === (sid ?? null) || !sid ? r.sessionId : s.active, running: { ...s.running, [r.sessionId]: true }, errors: { ...s.errors, [r.sessionId]: undefined } }))
      if (!sid) { await get().ensureSession(r.sessionId); void get().loadSessions() }
    } catch (e) { toast.error((e as Error).message) }
  },

  async abort(id) {
    const sid = id ?? get().active
    if (!sid) return
    set(s => ({ queue: { ...s.queue, [sid]: [] } }))
    await api.ai.abort(sid)
  },

  setComposer(p) {
    const next = { ...get().composer, ...p }
    set({ composer: next })
    const sid = get().active
    if (sid) void api.ai.sessions.setConfig(sid, { agent: next.agent, model: next.model, mode: next.mode, reasoning: next.reasoning })
    // remember the latest choices as defaults for new chats
    const patch: Record<string, unknown> = {}
    if (p.agent) patch.defaultAgent = p.agent
    if (p.mode) patch.permissionMode = p.mode
    if (p.reasoning) patch.reasoning = p.reasoning
    if (p.model) patch.defaultModel = p.model
    if (Object.keys(patch).length) void useSettings.getState().update({ ai: patch } as never)
  },
  setDraft(key, d) { set(s => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? { text: '', images: [], mentions: [] }), ...d } } })) },

  async addContext(item) {
    let sid = get().active
    if (!sid) {
      const s = await api.ai.sessions.create({ agent: get().composer.agent })
      set(st => ({ data: { ...st.data, [s.id]: s }, active: s.id, sessions: [{ id: s.id, title: s.title, projectRoot: s.projectRoot, createdAt: s.createdAt, updatedAt: s.updatedAt, agent: s.agent, messageCount: 0, preview: '' }, ...st.sessions] }))
      sid = s.id
    }
    const cur = get().context[sid]?.items ?? get().data[sid]?.context ?? []
    if (cur.some(c => c.kind === item.kind && c.path && c.path === item.path && !c.auto)) return
    const snap = await api.ai.context.setItems(sid, [...cur.filter(c => !c.auto), item])
    if (snap) set(st => ({ context: { ...st.context, [sid!]: snap } }))
  },
  async setContextItems(items) {
    const sid = get().active
    if (!sid) return
    const snap = await api.ai.context.setItems(sid, items)
    if (snap) set(st => ({ context: { ...st.context, [sid]: snap } }))
  },

  async removeSession(id) {
    await api.ai.sessions.delete(id)
    set(s => { const data = { ...s.data }; delete data[id]; return { data, sessions: s.sessions.filter(x => x.id !== id), active: s.active === id ? null : s.active } })
  },
  dismissError(id) { set(s => ({ errors: { ...s.errors, [id]: undefined } })) },
  todos(id) { return id ? get().data[id]?.todos ?? [] : [] }
}))

type S = (fn: ((s: AiState) => Partial<AiState>) | Partial<AiState>) => void
type G = () => AiState

function handle(e: AiEvent, set: S, get: G) {
  switch (e.type) {
    case 'session': {
      const m = e.session
      if (m.parentId) {
        set(s => ({ children: { ...s.children, [m.parentId!]: [...(s.children[m.parentId!] ?? []).filter(c => c.id !== m.id), m] }, data: s.data[m.id] ? s.data : { ...s.data, [m.id]: { id: m.id, title: m.title, projectRoot: m.projectRoot, createdAt: m.createdAt, updatedAt: m.updatedAt, agent: m.agent, messages: [], todos: [], context: [], usage: { input: 0, output: 0, cost: 0, steps: 0 }, parentId: m.parentId } }, running: { ...s.running, [m.id]: !!m.running } }))
      } else set(s => ({ sessions: [m, ...s.sessions.filter(x => x.id !== m.id)].sort((a, b) => b.updatedAt - a.updatedAt), running: { ...s.running, [m.id]: !!m.running } }))
      break
    }
    case 'message_start': set(s => {
      if (!s.data[e.sessionId]) { void get().ensureSession(e.sessionId); return {} }
      return { data: upsertMessage(s.data, e.sessionId, e.message), running: { ...s.running, [e.sessionId]: true } }
    }); break
    case 'message': case 'message_end': set(s => ({ data: upsertMessage(s.data, e.sessionId, e.message) })); break
    case 'delta': set(s => ({ data: updateMessage(s.data, e.sessionId, e.messageId, m => {
      const parts = m.parts.slice()
      const p = parts[e.index]
      if (p && (p.type === 'text' || p.type === 'reasoning')) parts[e.index] = { ...p, text: p.text + e.delta }
      return { ...m, parts }
    }) })); break
    case 'part': set(s => ({ data: updateMessage(s.data, e.sessionId, e.messageId, m => { const parts = m.parts.slice(); parts[e.index] = e.part; return { ...m, parts } }) })); break
    case 'status': set(s => ({ status: { ...s.status, [e.sessionId]: { status: e.status, detail: e.detail } } })); break
    case 'todos': set(s => s.data[e.sessionId] ? { data: { ...s.data, [e.sessionId]: { ...s.data[e.sessionId], todos: e.todos } } } : {}); break
    case 'usage': set(s => ({ usage: { ...s.usage, [e.sessionId]: e.usage } })); break
    case 'context': set(s => ({ context: { ...s.context, [e.sessionId]: e.snapshot } })); break
    case 'changes': set(s => ({ changes: { ...s.changes, [e.sessionId]: e.changes } })); break
    case 'title': set(s => ({ sessions: s.sessions.map(x => x.id === e.sessionId ? { ...x, title: e.title } : x), data: s.data[e.sessionId] ? { ...s.data, [e.sessionId]: { ...s.data[e.sessionId], title: e.title } } : s.data })); break
    case 'permission_request': set(s => ({ permissions: [...s.permissions.filter(p => p.id !== e.request.id), e.request] })); break
    case 'permission_resolved': set(s => ({ permissions: s.permissions.filter(p => p.id !== e.id) })); break
    case 'question_request': set(s => ({ questions: [...s.questions.filter(q => q.id !== e.request.id), e.request] })); break
    case 'question_resolved': set(s => ({ questions: s.questions.filter(q => q.id !== e.id) })); break
    case 'error': set(s => ({ errors: { ...s.errors, [e.sessionId]: e.message } })); break
    case 'reload': void api.ai.sessions.get(e.sessionId).then(sess => sess && set(s => ({ data: { ...s.data, [e.sessionId]: sess } }))); break
    case 'done': {
      set(s => ({ running: { ...s.running, [e.sessionId]: false }, status: { ...s.status, [e.sessionId]: { status: 'idle' } } }))
      void get().loadSessions()
      const q = get().queue[e.sessionId]
      if (q?.length && e.reason !== 'aborted' && e.reason !== 'error') {
        const [next, ...rest] = q
        set(s => ({ queue: { ...s.queue, [e.sessionId]: rest } }))
        void api.ai.send({ ...next, sessionId: e.sessionId }).then(() => set(s => ({ running: { ...s.running, [e.sessionId]: true } })))
      }
      break
    }
  }
}
