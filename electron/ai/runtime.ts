import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AiEvent, ContextItem, FileChange, Message, Part, PermissionReply, QuestionItem, QuestionReply, QuestionRequest, RunStatus, SendRequest, Session, Todo, ToolPart } from '../../shared/ai'
import type { AgentConfig, ModelRef, PermissionMode, ReasoningEffort, Settings } from '../../shared/settings'
import { emit } from '../services/events'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { dataDir } from '../services/paths'
import { uid } from '../services/storage'
import { log } from '../services/log'
import { loadAgents } from './agents'
import { buildContext, estimateTokens, quickSnapshot, truncateTokens } from './context'
import { buildSystemPrompt, estimateChatTokens, renderTranscript, toChatMessages } from './conversation'
import { runHooks } from './hooks'
import { listSkills, loadInstructions, loadSkill, readMemory, writeMemory } from './knowledge'
import { PermissionManager } from './permissions'
import { COMPACTION_PROMPT, TITLE_PROMPT } from './prompts'
import { createProvider, ProviderError, type ChatMessage, type ChatRequest, type StreamEvent, type ToolSpec } from './providers'
import { resolveModels, smallModel, type Candidate } from './router'
import { sessions, metaOf, messageText } from './sessions'
import { snapshots } from './snapshots'
import { findTool, toolsForAgent, type RegistryDeps } from './tools/registry'
import { ToolError, type ToolContext, type ToolDef, type ToolResult, type ToolRuntime } from './tools/types'
import { truncateOutput } from './tools/util'

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
})

class AbortedError extends Error { constructor() { super('Cancelled') } }

interface TurnOpts { isSub?: boolean; depth?: number; rootSessionId?: string; turnId?: string; modeOverride?: PermissionMode }
interface TurnResult { finalText: string; steps: number; reason: 'complete' | 'aborted' | 'error' | 'max_steps' }

interface StepResult { toolCalls: ToolPart[]; finish: string; inputTokens: number; outputTokens: number; cand: Candidate }

type PostEditProvider = (paths: string[], signal: AbortSignal) => Promise<string>

export class AgentRuntime {
  readonly permissions = new PermissionManager(e => this.emitEvent(e))
  private runs = new Map<string, { abort: AbortController; status: RunStatus }>()
  private questions = new Map<string, { req: QuestionRequest; resolve(r: QuestionReply | null): void }>()
  private reads = new Map<string, Map<string, number>>()
  private postEdit: PostEditProvider[] = []

  emitEvent(e: AiEvent): void { emit('ai:event', e) }

  registerPostEdit(fn: PostEditProvider): void { this.postEdit.push(fn) }

  isRunning(sessionId: string): boolean { return this.runs.has(sessionId) }
  runningIds(): string[] { return [...this.runs.keys()] }
  status(sessionId: string): RunStatus { return this.runs.get(sessionId)?.status ?? 'idle' }

  private setStatus(sessionId: string, status: RunStatus, detail?: string): void {
    const r = this.runs.get(sessionId)
    if (r) r.status = status
    this.emitEvent({ type: 'status', sessionId, status, detail })
  }

  private projectRoot(): { root: string; hasProject: boolean } {
    const r = workspace.root
    if (r) return { root: r, hasProject: true }
    return { root: dataDir('scratch'), hasProject: false }
  }

  private deps(root: string | null, skillList: { name: string; description: string }[], agents: AgentConfig[]): RegistryDeps {
    void root
    return { skills: () => skillList, subagents: () => agents.filter(a => a.mode !== 'primary' && !a.hidden).map(a => ({ id: a.id, name: a.name, description: a.description })) }
  }

  // ───────────────────────────── public API ─────────────────────────────

  async send(req: SendRequest): Promise<{ sessionId: string }> {
    const { root, hasProject } = this.projectRoot()
    let session = req.sessionId ? sessions.get(req.sessionId) : null
    if (!session) session = sessions.create({ projectRoot: hasProject ? root : null, agent: req.agent ?? settings.get().ai.defaultAgent })
    if (this.runs.has(session.id)) throw new Error('This chat is still working. Wait for it to finish or stop it first.')
    if (req.agent) session.agent = req.agent
    if (req.model !== undefined) session.model = req.model
    if (req.reasoning) session.reasoning = req.reasoning
    if (req.mode) session.mode = req.mode
    const ac = new AbortController()
    this.runs.set(session.id, { abort: ac, status: 'thinking' })
    sessions.setRunning(session.id, true)
    this.emitEvent({ type: 'session', session: metaOf(session, true) })
    const s = session
    void (async () => {
      let reason: TurnResult['reason'] = 'complete'
      try {
        const r = await this.turn(s, req, ac.signal, {})
        reason = r.reason
      } catch (e) {
        if (e instanceof AbortedError || ac.signal.aborted) reason = 'aborted'
        else {
          reason = 'error'
          const msg = e instanceof Error ? e.message : String(e)
          log.error('ai', msg)
          this.emitEvent({ type: 'error', sessionId: s.id, message: msg })
          void runHooks({ event: 'error', sessionId: s.id, error: msg }, hasProject ? root : null)
        }
      } finally {
        this.runs.delete(s.id)
        sessions.setRunning(s.id, false)
        this.permissions.cancelSession(s.id)
        this.cancelQuestions(s.id)
        sessions.saveNow(s)
        this.emitEvent({ type: 'status', sessionId: s.id, status: 'idle' })
        this.emitEvent({ type: 'done', sessionId: s.id, reason })
        this.emitEvent({ type: 'session', session: metaOf(s, false) })
      }
    })()
    return { sessionId: session.id }
  }

  abort(sessionId: string): void {
    this.runs.get(sessionId)?.abort.abort()
    this.permissions.cancelSession(sessionId)
    this.cancelQuestions(sessionId)
  }

  answerPermission(r: PermissionReply): void { this.permissions.reply(r) }

  answerQuestion(r: QuestionReply): void {
    const q = this.questions.get(r.id)
    if (!q) return
    this.questions.delete(r.id)
    this.emitEvent({ type: 'question_resolved', id: r.id, sessionId: q.req.sessionId })
    q.resolve(r)
  }

  private cancelQuestions(sessionId: string): void {
    for (const [id, q] of [...this.questions]) if (q.req.sessionId === sessionId) { this.questions.delete(id); this.emitEvent({ type: 'question_resolved', id, sessionId }); q.resolve(null) }
  }

  pending(): { permissions: ReturnType<PermissionManager['pendingRequests']>; questions: QuestionRequest[] } {
    return { permissions: this.permissions.pendingRequests(), questions: [...this.questions.values()].map(q => q.req) }
  }

  // ───────────────────────────── one-shot completion ─────────────────────────────

  async oneShot(cand: Candidate, system: string, user: string, signal?: AbortSignal, opts: { maxTokens?: number; images?: { mime: string; data: string }[] } = {}): Promise<string> {
    const provider = createProvider(cand.provider)
    const msg: ChatMessage = { role: 'user', content: [...(opts.images ?? []).map(i => ({ type: 'image' as const, mime: i.mime, data: i.data })), { type: 'text', text: user }] }
    let out = ''
    for await (const ev of provider.streamChat({ model: cand.ref.model, modelInfo: cand.info, system, messages: [msg], maxTokens: opts.maxTokens ?? 4096, reasoning: 'off', signal })) {
      if (ev.type === 'text') out += ev.delta
    }
    return out.trim()
  }

  /** Model to use for housekeeping tasks (titles, summaries, commit messages). */
  async helperModel(sessionModel?: ModelRef | null): Promise<Candidate | null> {
    const s = settings.get()
    const fake = { id: 'helper', title: '', projectRoot: null, createdAt: 0, updatedAt: 0, agent: 'build', messages: [], todos: [], context: [], usage: { input: 0, output: 0, cost: 0, steps: 0 }, model: sessionModel } as Session
    const cands = resolveModels({ settings: s, agent: { id: 'build' } as AgentConfig, session: fake, explicit: sessionModel, hasImages: false, promptTokens: 0, userText: '' })
    return cands[0] ? smallModel(s, cands[0]) : null
  }

  // ───────────────────────────── the turn loop ─────────────────────────────

  private async turn(session: Session, req: SendRequest, signal: AbortSignal, opts: TurnOpts): Promise<TurnResult> {
    const { root, hasProject } = this.projectRoot()
    const s = settings.effective(hasProject ? root : null)
    const agents = await loadAgents(hasProject ? root : null, s)
    const mentionAgent = req.mentions?.find(m => m.kind === 'agent')?.value
    const agent = agents.find(a => a.id === (mentionAgent ?? session.agent)) ?? agents.find(a => a.id === 'build')!
    const mode: PermissionMode = opts.modeOverride ?? session.mode ?? s.ai.permissionMode
    const reasoning: ReasoningEffort = req.reasoning ?? session.reasoning ?? agent.reasoning ?? s.ai.reasoning
    const isSub = !!opts.isSub
    const rootSessionId = opts.rootSessionId ?? session.id
    const skillList = (await listSkills(hasProject ? root : null)).map(k => ({ name: k.name, description: k.description }))
    const deps = this.deps(root, skillList, agents)
    const instructions = loadInstructions(hasProject ? root : null)
    const memory = await readMemory(hasProject ? root : null)

    // ── hooks & first-message bookkeeping
    if (!isSub && session.messages.length === 0) await runHooks({ event: 'session.start', sessionId: session.id, cwd: root }, hasProject ? root : null)
    const pre = await runHooks({ event: 'message.before', sessionId: session.id, input: req.text, agent: agent.id }, hasProject ? root : null)
    if (pre.denied) throw new Error(`Blocked by a hook: ${pre.denied}`)

    // ── model & budget
    const history0 = toChatMessages(session)
    let candidates = resolveModels({ settings: s, agent, session, explicit: req.model ?? (isSub ? agent.model ?? session.model : null), hasImages: !!req.images?.length, promptTokens: estimateChatTokens(history0, '', []), userText: req.text })
    if (!candidates.length) throw new Error('No AI model is configured yet. Open Settings → Models, add a provider (for example Anthropic, OpenAI, Gemini, or a local Ollama / LM Studio server) and pick a model.')
    let cand = candidates[0]
    const window = cand.info?.contextWindow ?? 128_000
    const reserve = Math.min(cand.info?.maxOutput ?? 16_000, 16_000)
    const ratio = session.tokenRatio ?? 1
    const system = buildSystemPrompt({ agent, root, hasProject, settings: s, instructions, memory, isSub })
    const systemTokens = Math.ceil(estimateTokens(system) * ratio)

    // ── user message (with attached context)
    const turnId = opts.turnId ?? uid('m-')
    const built = await buildContext({
      session, root: hasProject ? root : null, settings: s, agent, userText: req.text, mentions: req.mentions ?? [], editor: req.editor,
      window, systemTokens, historyTokens: Math.ceil(estimateChatTokens(history0, '', []) * ratio), reserveOutput: reserve, ratio
    })
    const parts: Part[] = []
    if (built.text) parts.push({ type: 'text', text: built.text, synthetic: true })
    for (const img of [...(req.images ?? []), ...built.images]) parts.push({ type: 'image', ...img })
    parts.push({ type: 'text', text: req.text })
    const userMsg: Message = { id: turnId, role: 'user', parts, ts: Date.now(), agent: agent.id }
    session.messages.push(userMsg)
    session.context = built.items.filter(i => !(i.once)).map(i => i)
    sessions.logUsage({ ts: userMsg.ts, model: '', input: 0, output: 0, sessionId: session.id, kind: 'user' })
    if (!session.titled && session.messages.filter(m => m.role === 'user').length === 1 && !isSub) { session.title = req.text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'; this.emitEvent({ type: 'title', sessionId: session.id, title: session.title }) }
    sessions.save(session)
    this.emitEvent({ type: 'message', sessionId: session.id, message: userMsg })
    this.emitEvent({ type: 'context', sessionId: session.id, snapshot: built.snapshot })

    const maxSteps = agent.maxSteps ?? (isSub ? 40 : s.ai.maxSteps)
    const recent: string[] = []
    let step = 0, nudges = 0, lengthNudges = 0
    let finalReason: TurnResult['reason'] = 'complete'

    for (;;) {
      if (signal.aborted) throw new AbortedError()
      if (step >= maxSteps) {
        this.pushNotice(session, `Stopped after ${maxSteps} steps. Send a message to let the agent continue.`)
        finalReason = 'max_steps'
        break
      }
      step++
      const toolDefs = toolsForAgent(agent, deps, isSub)
      const specs: ToolSpec[] = toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))

      // ── compaction
      let chat = toChatMessages(session)
      const est = Math.ceil(estimateChatTokens(chat, system, specs) * (session.tokenRatio ?? 1))
      if (s.ai.autoCompact && est > window * s.ai.compactThreshold) {
        if (await this.compact(session, cand, signal, true).catch(() => false)) chat = toChatMessages(session)
      }

      const assistant: Message = { id: uid('m-'), role: 'assistant', parts: [], ts: Date.now(), agent: agent.id, model: cand.ref }
      session.messages.push(assistant)
      this.emitEvent({ type: 'message_start', sessionId: session.id, message: assistant })
      this.setStatus(session.id, 'thinking')

      let result: StepResult
      try {
        result = await this.streamStep({ session, assistant, system, specs, reasoning, candidates, signal, s, agent, ratio: () => session.tokenRatio ?? 1, window })
      } catch (e) {
        assistant.finish = e instanceof AbortedError || signal.aborted ? 'aborted' : 'error'
        if (assistant.finish === 'error') assistant.error = e instanceof Error ? e.message : String(e)
        for (const p of assistant.parts) if (p.type === 'tool' && (p.state === 'pending' || p.state === 'running')) { p.state = 'error'; p.output = '[Cancelled]' }
        this.emitEvent({ type: 'message_end', sessionId: session.id, message: assistant })
        sessions.save(session)
        if (assistant.parts.length === 0 && assistant.finish === 'error') session.messages.pop()
        throw e
      }
      cand = result.cand
      session.usage.steps++
      session.usage.input += result.inputTokens
      session.usage.output += result.outputTokens
      const price = cand.info
      const cost = price?.inputPrice != null || price?.outputPrice != null ? (result.inputTokens * (price?.inputPrice ?? 0) + result.outputTokens * (price?.outputPrice ?? 0)) / 1_000_000 : 0
      session.usage.cost += cost
      assistant.usage = { input: result.inputTokens, output: result.outputTokens, cost: cost || undefined }
      assistant.finish = result.finish === 'length' ? 'length' : result.toolCalls.length ? 'tool_calls' : result.finish === 'refusal' ? 'error' : 'stop'
      sessions.logUsage({ ts: Date.now(), model: `${cand.ref.provider}/${cand.ref.model}`, input: result.inputTokens, output: result.outputTokens, sessionId: session.id, kind: 'assistant' })
      this.emitEvent({ type: 'usage', sessionId: session.id, usage: session.usage })

      if (result.finish === 'refusal') {
        assistant.error = assistant.error ?? 'The model declined to answer this request.'
        this.emitEvent({ type: 'message_end', sessionId: session.id, message: assistant })
        finalReason = 'complete'
        break
      }

      if (!result.toolCalls.length) {
        this.emitEvent({ type: 'message_end', sessionId: session.id, message: assistant })
        if (result.finish === 'length' && lengthNudges < 2) {
          lengthNudges++
          this.pushSynthetic(session, 'Your previous reply was cut off by the output limit. Continue exactly where you stopped (do not repeat what you already wrote).')
          continue
        }
        const open = session.todos.filter(t => t.status !== 'completed')
        if (!isSub && agent.id === 'build' && open.length && nudges < 2 && assistant.parts.some(p => p.type === 'text')) {
          const stillWorking = open.some(t => t.status === 'in_progress')
          if (stillWorking) {
            nudges++
            this.pushSynthetic(session, `Your todo list still has unfinished items:\n${open.map(t => `- [${t.status}] ${t.content}`).join('\n')}\nContinue working on them, or update the list with todowrite if they are actually done or no longer needed. If everything is truly complete, mark the items completed and give your final summary.`)
            continue
          }
        }
        break
      }

      // ── execute tool calls
      const calls = result.toolCalls
      const defs = calls.map(c => findTool(toolDefs, c.name))
      const parallel = calls.length > 1 && defs.every(d => d && (d.readOnly || d.name === 'subagent'))
      const exec = (c: ToolPart, def: ToolDef | undefined) => this.executeTool({ session, assistant, call: c, def, toolDefs, agent, mode, root, hasProject, s, signal, turnId, rootSessionId, recent, depth: opts.depth ?? 0 })
      if (parallel) await Promise.all(calls.map((c, i) => exec(c, defs[i])))
      else for (let i = 0; i < calls.length; i++) { if (signal.aborted) break; await exec(calls[i], defs[i]) }
      if (signal.aborted) {
        for (const p of assistant.parts) if (p.type === 'tool' && (p.state === 'pending' || p.state === 'running')) { p.state = 'error'; p.output = '[Cancelled by user]'; p.endedAt = Date.now() }
        assistant.finish = 'aborted'
        this.emitEvent({ type: 'message_end', sessionId: session.id, message: assistant })
        throw new AbortedError()
      }
      this.emitEvent({ type: 'message_end', sessionId: session.id, message: assistant })
      sessions.save(session)
      if (recent.length >= 5 && recent.slice(-5).every(k => k === recent[recent.length - 1])) {
        this.pushNotice(session, 'Stopped: the agent kept repeating the same tool call. Try rephrasing the request or giving more guidance.')
        finalReason = 'error'
        break
      }
      void this.emitChanges(rootSessionId, hasProject ? root : null)
    }

    // ── wrap up
    session.context = session.context.filter(i => !i.once)
    void runHooks({ event: 'turn.end', sessionId: session.id, cwd: root }, hasProject ? root : null)
    sessions.save(session)
    this.emitEvent({ type: 'context', sessionId: session.id, snapshot: quickSnapshot(session, window, systemTokens, Math.ceil(estimateChatTokens(toChatMessages(session), '', []) * (session.tokenRatio ?? 1))) })
    void this.emitChanges(rootSessionId, hasProject ? root : null)
    if (!isSub && !session.titled && finalReason === 'complete') void this.generateTitle(session, req.text, cand)
    const last = [...session.messages].reverse().find(m => m.role === 'assistant' && !m.notice)
    return { finalText: last ? messageText(last) : '', steps: step, reason: finalReason }
  }

  private pushNotice(session: Session, text: string): void {
    const m: Message = { id: uid('m-'), role: 'assistant', parts: [{ type: 'text', text }], ts: Date.now(), notice: true }
    session.messages.push(m)
    this.emitEvent({ type: 'message', sessionId: session.id, message: m })
  }

  private pushSynthetic(session: Session, text: string): void {
    const m: Message = { id: uid('m-'), role: 'user', parts: [{ type: 'text', text, synthetic: true }], ts: Date.now() }
    session.messages.push(m)
    this.emitEvent({ type: 'message', sessionId: session.id, message: m })
  }

  private async emitChanges(rootSessionId: string, root: string | null): Promise<void> {
    try { const changes: FileChange[] = await snapshots.summary(rootSessionId, root); this.emitEvent({ type: 'changes', sessionId: rootSessionId, changes }) } catch { /* ignore */ }
  }

  // ───────────────────────────── streaming one model call ─────────────────────────────

  private async streamStep(a: {
    session: Session; assistant: Message; system: string; specs: ToolSpec[]; reasoning: ReasoningEffort; candidates: Candidate[]; signal: AbortSignal
    s: Settings; agent: AgentConfig; ratio: () => number; window: number
  }): Promise<StepResult> {
    const { session, assistant, signal } = a
    let lastErr: unknown = null
    let compactedOnce = false
    let candIdx = 0
    const maxRetries = a.s.ai.maxRetries

    while (candIdx < a.candidates.length) {
      const cand = a.candidates[candIdx]
      let provider
      try { provider = createProvider(cand.provider) } catch (e) { lastErr = e; candIdx++; continue }
      assistant.model = cand.ref
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) throw new AbortedError()
        assistant.parts = []
        assistant.error = undefined
        if (attempt > 0 || candIdx > 0) this.emitEvent({ type: 'message_start', sessionId: session.id, message: assistant })
        const chat = toChatMessages(session)
        const sent = estimateChatTokens(chat, a.system, a.specs)
        const request: ChatRequest = {
          model: cand.ref.model, modelInfo: cand.info, system: a.system, messages: chat, tools: a.specs.length ? a.specs : undefined,
          temperature: a.agent.temperature, maxTokens: cand.info?.maxOutput ? Math.min(cand.info.maxOutput, 64_000) : undefined, reasoning: cand.info?.reasoning === false ? 'off' : a.reasoning,
          showReasoning: a.s.ai.showReasoning, signal, idleTimeoutMs: a.s.ai.requestTimeoutSec * 1000
        }
        try {
          const r = await this.consumeStream(provider.streamChat(request), a, cand)
          // calibrate the token estimator against what the provider reports
          if (r.inputTokens > 200 && sent > 200) {
            const observed = r.inputTokens / sent
            session.tokenRatio = Math.min(2, Math.max(0.5, 0.6 * (session.tokenRatio ?? observed) + 0.4 * observed))
          }
          return r
        } catch (e) {
          if (signal.aborted || e instanceof AbortedError) throw new AbortedError()
          lastErr = e
          const pe = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), 'other')
          log.warn('ai', `${cand.ref.provider}/${cand.ref.model}: ${pe.message}`)
          if (pe.kind === 'context_length' && !compactedOnce) {
            compactedOnce = true
            this.setStatus(session.id, 'compacting')
            if (await this.compact(session, cand, signal, true).catch(() => false)) continue
          }
          if (pe.retryable && attempt < maxRetries) {
            const wait = pe.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 400)
            this.setStatus(session.id, 'retrying', `${pe.kind === 'rate_limit' ? 'Rate limited' : 'Retrying'} – attempt ${attempt + 2} of ${maxRetries + 1}`)
            try { await sleep(wait, signal) } catch { throw new AbortedError() }
            continue
          }
          break
        }
      }
      candIdx++
      if (candIdx < a.candidates.length) {
        this.pushNotice(session, `${cand.ref.model} is unavailable (${lastErr instanceof Error ? lastErr.message.slice(0, 140) : 'error'}). Switching to ${a.candidates[candIdx].ref.model}.`)
        session.messages.splice(session.messages.indexOf(assistant), 1)
        session.messages.push(assistant)
      }
    }
    throw lastErr ?? new Error('The model request failed.')
  }

  private async consumeStream(stream: AsyncGenerator<StreamEvent>, a: { session: Session; assistant: Message; signal: AbortSignal }, cand: Candidate): Promise<StepResult> {
    const { session, assistant } = a
    let textIdx = -1, reasonIdx = -1
    const toolIdx = new Map<string, number>()
    const argChars = new Map<string, number>()
    const toolCalls: ToolPart[] = []
    const used = new Set<string>()
    for (const m of session.messages) for (const p of m.parts) if (p.type === 'tool') used.add(p.id)
    const idMap = new Map<string, string>()
    const uniqueId = (orig: string): string => {
      const known = idMap.get(orig)
      if (known) return known
      const id = !orig || used.has(orig) ? `tc_${uid()}` : orig
      used.add(id); idMap.set(orig, id)
      return id
    }
    let finish = 'stop', inTok = 0, outTok = 0
    let buf: { kind: 'text' | 'reasoning'; index: number; text: string } | null = null
    let timer: NodeJS.Timeout | null = null
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (buf && buf.text) this.emitEvent({ type: 'delta', sessionId: session.id, messageId: assistant.id, index: buf.index, kind: buf.kind, delta: buf.text })
      buf = null
    }
    const queue = (kind: 'text' | 'reasoning', index: number, delta: string) => {
      if (buf && (buf.kind !== kind || buf.index !== index)) flush()
      if (!buf) buf = { kind, index, text: '' }
      buf.text += delta
      if (!timer) timer = setTimeout(flush, 40)
    }
    const emitPart = (index: number) => { flush(); this.emitEvent({ type: 'part', sessionId: session.id, messageId: assistant.id, index, part: assistant.parts[index] }) }

    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'text': {
            if (textIdx < 0 || assistant.parts[textIdx]?.type !== 'text' || textIdx !== assistant.parts.length - 1) { assistant.parts.push({ type: 'text', text: '' }); textIdx = assistant.parts.length - 1; emitPart(textIdx) }
            ;(assistant.parts[textIdx] as { text: string }).text += ev.delta
            queue('text', textIdx, ev.delta)
            break
          }
          case 'reasoning': {
            if (reasonIdx < 0 || assistant.parts[reasonIdx]?.type !== 'reasoning' || reasonIdx !== assistant.parts.length - 1) { assistant.parts.push({ type: 'reasoning', text: '' }); reasonIdx = assistant.parts.length - 1; emitPart(reasonIdx) }
            ;(assistant.parts[reasonIdx] as { text: string }).text += ev.delta
            queue('reasoning', reasonIdx, ev.delta)
            break
          }
          case 'reasoning_block': {
            if (reasonIdx < 0 || assistant.parts[reasonIdx]?.type !== 'reasoning') { assistant.parts.push({ type: 'reasoning', text: '' }); reasonIdx = assistant.parts.length - 1 }
            const p = assistant.parts[reasonIdx] as { type: 'reasoning'; text: string; signature?: string; redacted?: string }
            if (ev.signature) p.signature = ev.signature
            if (ev.redacted) p.redacted = ev.redacted
            reasonIdx = -1
            emitPart(assistant.parts.indexOf(p))
            break
          }
          case 'tool_start': {
            const id = uniqueId(ev.id)
            const part: ToolPart = { type: 'tool', id, name: ev.name, input: {}, state: 'pending', startedAt: Date.now(), title: `Preparing ${ev.name}…` }
            assistant.parts.push(part)
            toolIdx.set(ev.id, assistant.parts.length - 1)
            emitPart(assistant.parts.length - 1)
            break
          }
          case 'tool_args': {
            const n = (argChars.get(ev.id) ?? 0) + ev.delta.length
            argChars.set(ev.id, n)
            const i = toolIdx.get(ev.id)
            if (i !== undefined && n % 400 < ev.delta.length) {
              const p = assistant.parts[i] as ToolPart
              p.meta = { ...(p.meta ?? {}), streaming: true, argsChars: n }
              emitPart(i)
            }
            break
          }
          case 'tool_call': {
            let i = toolIdx.get(ev.id)
            if (i === undefined) { const id = uniqueId(ev.id); assistant.parts.push({ type: 'tool', id, name: ev.name, input: {}, state: 'pending', startedAt: Date.now() }); i = assistant.parts.length - 1; toolIdx.set(ev.id, i) }
            const p = assistant.parts[i] as ToolPart
            p.input = ev.input
            if (ev.parseError) p.meta = { ...(p.meta ?? {}), parseError: ev.parseError }
            if (ev.providerMeta) p.providerMeta = ev.providerMeta
            p.meta = { ...(p.meta ?? {}), streaming: false }
            p.title = undefined
            toolCalls.push(p)
            emitPart(i)
            break
          }
          case 'usage': inTok = ev.input; outTok = ev.output; break
          case 'notice': this.pushNotice(session, ev.text); break
          case 'finish':
            finish = ev.reason
            if (ev.reason === 'refusal') assistant.error = ev.detail ? `The model declined this request (${ev.detail}).` : 'The model declined this request.'
            break
        }
      }
    } finally { flush() }
    if (!inTok && !outTok) { // provider did not report usage – estimate
      inTok = Math.ceil(estimateChatTokens(toChatMessages(session), '', []))
      outTok = estimateTokens(assistant.parts.map(p => (p.type === 'text' || p.type === 'reasoning' ? p.text : JSON.stringify((p as ToolPart).input))).join(''))
    }
    return { toolCalls, finish, inputTokens: inTok, outputTokens: outTok, cand }
  }

  // ───────────────────────────── tool execution ─────────────────────────────

  private async executeTool(x: {
    session: Session; assistant: Message; call: ToolPart; def: ToolDef | undefined; toolDefs: ToolDef[]; agent: AgentConfig; mode: PermissionMode
    root: string; hasProject: boolean; s: Settings; signal: AbortSignal; turnId: string; rootSessionId: string; recent: string[]; depth: number
  }): Promise<void> {
    const { call, session, assistant, signal } = x
    const update = (p: Partial<ToolPart>) => { Object.assign(call, p); this.emitEvent({ type: 'part', sessionId: session.id, messageId: assistant.id, index: assistant.parts.indexOf(call), part: call }) }
    const fail = (output: string, state: ToolPart['state'] = 'error') => update({ state, output, endedAt: Date.now(), title: call.title })

    if (!x.def) {
      const known = x.toolDefs.map(t => t.name).join(', ')
      return fail(`Unknown tool "${call.name}". Available tools: ${known}.`)
    }
    const def = x.def
    if (call.meta?.parseError) return fail(`Could not parse the arguments for ${def.name}: ${String(call.meta.parseError)}`)

    const key = `${def.name}:${JSON.stringify(call.input)}`
    x.recent.push(key)
    if (x.recent.length >= 3 && x.recent.slice(-3).every(k => k === key)) {
      return fail(`You have made this exact ${def.name} call ${x.recent.filter(k => k === key).length} times in a row without progress. Stop repeating it: re-read the situation, try a different approach, or tell the user what is blocking you.`)
    }

    const v = def.validate(call.input)
    if (!v.ok) return fail(`${v.error}\nExpected parameters: ${JSON.stringify(def.parameters)}`)
    call.input = v.value

    const ac = new AbortController()
    const onAbort = () => ac.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const toolRuntime = this.makeToolRuntime(x.session, x.assistant, call, x.rootSessionId, x.turnId, x.root, x.hasProject, update)
    const ctx: ToolContext = { sessionId: session.id, agent: x.agent, root: x.root, cwd: x.root, signal: ac.signal, toolCallId: call.id, settings: x.s, runtime: toolRuntime }

    try {
      let described
      try { described = await def.describe(v.value, ctx) } catch (e) { return fail(e instanceof ToolError ? e.message : `Tool error: ${(e as Error).message}`) }
      update({ title: described.title })
      const hookRes = await runHooks({ event: 'tool.before', sessionId: session.id, tool: def.name, input: v.value, cwd: x.root, agent: x.agent.id }, x.hasProject ? x.root : null)
      if (hookRes.denied) return fail(`Blocked by a hook: ${hookRes.denied}`, 'denied')

      for (const check of described.checks) {
        this.setStatus(session.id, 'waiting_permission')
        const auth = await this.permissions.authorize(check, { sessionId: session.id, agent: x.agent, toolName: def.name, mode: x.mode, root: x.root, signal, settings: x.s })
        if (!auth.allowed) {
          this.setStatus(session.id, 'tool')
          if (signal.aborted) return fail('[Cancelled by user]')
          return fail(auth.reason, 'denied')
        }
      }
      this.setStatus(session.id, 'tool')
      update({ state: 'running', startedAt: Date.now() })
      const timeoutMs = def.timeoutMs ?? 120_000
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let res: ToolResult
      try {
        res = await Promise.race([
          def.execute(v.value, ctx, described.plan),
          new Promise<never>((_r, rej) => ac.signal.addEventListener('abort', () => rej(signal.aborted ? new AbortedError() : new ToolError(`Timed out after ${Math.round(timeoutMs / 1000)}s.`)), { once: true }))
        ])
      } finally { clearTimeout(timer) }

      let output = res.output
      if (res.meta?.diff?.length && !res.isError) {
        const paths = res.meta.diff.map(d => (res.meta?.path as string | undefined) ?? d.path)
        for (const pe of this.postEdit) {
          try { const extra = await pe(paths.map(p => (/^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${x.root}/${p}`)), signal); if (extra) output += `\n\n${extra}` } catch { /* diagnostics are best-effort */ }
        }
        void runHooks({ event: 'file.edited', sessionId: session.id, tool: def.name, path: res.meta.diff[0].path, cwd: x.root }, x.hasProject ? x.root : null)
      }
      const t = await truncateOutput(output, { maxChars: 60_000, maxLines: 4000 })
      update({ state: res.isError ? 'error' : 'completed', output: t.text, title: res.title ?? call.title, meta: { ...(call.meta ?? {}), ...(res.meta ?? {}), streaming: false, images: res.images, truncated: t.truncated || res.meta?.truncated }, endedAt: Date.now() })
      void runHooks({ event: 'tool.after', sessionId: session.id, tool: def.name, input: v.value, output: t.text, cwd: x.root }, x.hasProject ? x.root : null)
    } catch (e) {
      if (e instanceof AbortedError || signal.aborted) return fail('[Cancelled by user]')
      if (e instanceof ToolError) return fail(e.message)
      log.error('tool', `${def.name}: ${(e as Error).stack ?? e}`)
      return fail(`Tool "${def.name}" failed: ${(e as Error).message}`)
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  private fileReads(sessionId: string): Map<string, number> {
    let m = this.reads.get(sessionId)
    if (!m) { m = new Map(); this.reads.set(sessionId, m) }
    return m
  }

  private makeToolRuntime(session: Session, assistant: Message, call: ToolPart, rootSessionId: string, turnId: string, root: string, hasProject: boolean, update: (p: Partial<ToolPart>) => void): ToolRuntime {
    const reads = this.fileReads(session.id)
    return {
      session,
      setTodos: (todos: Todo[]) => { session.todos = todos; sessions.save(session); this.emitEvent({ type: 'todos', sessionId: session.id, todos }) },
      ask: async (questions: QuestionItem[]) => {
        const req: QuestionRequest = { id: uid('q-'), sessionId: session.id, questions, ts: Date.now() }
        this.setStatus(session.id, 'waiting_question')
        const reply = await new Promise<QuestionReply | null>(resolve => { this.questions.set(req.id, { req, resolve }); this.emitEvent({ type: 'question_request', request: req }) })
        this.setStatus(session.id, 'tool')
        return reply && !reply.cancelled && reply.answers ? reply.answers : null
      },
      runSubagent: async o => {
        const agents = await loadAgents(hasProject ? root : null)
        const target = agents.find(a => a.id === o.agent.toLowerCase()) ?? agents.find(a => a.name.toLowerCase() === o.agent.toLowerCase())
        if (!target || target.mode === 'primary') throw new ToolError(`Unknown sub-agent "${o.agent}". Available: ${agents.filter(a => a.mode !== 'primary').map(a => a.id).join(', ')}`)
        const child = sessions.create({ projectRoot: session.projectRoot, agent: target.id, parentId: session.id, title: o.description, titled: true, mode: session.mode })
        this.emitEvent({ type: 'session', session: metaOf(child, true) })
        update({ meta: { ...(call.meta ?? {}), childSessionId: child.id } })
        const r = await this.turn(child, { text: o.prompt, agent: target.id, mode: session.mode }, o.signal, { isSub: true, depth: 1, rootSessionId, turnId, modeOverride: session.mode })
        sessions.saveNow(child)
        this.emitEvent({ type: 'session', session: metaOf(child, false) })
        if (r.reason === 'aborted') throw new AbortedError()
        return { text: r.finalText, sessionId: child.id, steps: r.steps }
      },
      markRead: (p, m) => { reads.set(p, m) },
      lastRead: p => reads.get(p),
      recordChange: async c => { await snapshots.record(rootSessionId, turnId, assistant.id, c) },
      loadSkill: name => loadSkill(hasProject ? root : null, name),
      listSkills: () => [],
      memory: { read: async scope => (await readMemory(hasProject ? root : null))[scope], write: (scope, text) => writeMemory(hasProject ? root : null, scope, text) },
      progress: u => { update({ ...(u.title ? { title: u.title } : {}), ...(u.output !== undefined ? { output: u.output } : {}), ...(u.meta ? { meta: { ...(call.meta ?? {}), ...u.meta } } : {}) }) }
    }
  }

  // ───────────────────────────── compaction & titles ─────────────────────────────

  /** Replace older history with a model-written summary. Returns false when there was nothing to compact. */
  async compact(session: Session, cand: Candidate, signal: AbortSignal | undefined, quiet = false): Promise<boolean> {
    const msgs = session.messages
    let start = 0
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].summary) { start = i; break }
    const userIdx = msgs.map((m, i) => ({ m, i })).filter(x => x.i >= start && x.m.role === 'user' && !x.m.summary && !x.m.notice && x.m.parts.some(p => p.type === 'text' && !p.synthetic)).map(x => x.i)
    let keepFrom: number
    if (userIdx.length >= 2) keepFrom = userIdx[userIdx.length - 1]
    else keepFrom = Math.max(start + 1, msgs.length - 7)
    // never split inside a message group: start the kept tail at an assistant/user boundary
    while (keepFrom < msgs.length && msgs[keepFrom].notice) keepFrom++
    const toSummarize = msgs.slice(start, keepFrom).filter(m => !m.notice)
    if (toSummarize.length < 2 && !(toSummarize.length === 1 && toSummarize[0].summary === undefined && toSummarize[0].role === 'user')) return false
    void quiet
    this.setStatus(session.id, 'compacting')
    const helper = smallModel(settings.get(), cand)
    let text: string
    try {
      text = await this.oneShot(helper, COMPACTION_PROMPT, renderTranscript(toSummarize), signal, { maxTokens: 3000 })
    } catch (e) {
      log.warn('ai', `compaction with ${helper.ref.model} failed: ${(e as Error).message}`)
      text = ''
    }
    if (!text) text = truncateTokens(renderTranscript(toSummarize, 30_000), 6000).text
    const summary: Message = { id: uid('m-'), role: 'user', summary: true, ts: Date.now(), parts: [{ type: 'text', text }] }
    msgs.splice(keepFrom, 0, summary)
    session.compactedUpTo = msgs[keepFrom - 1]?.id
    sessions.save(session)
    this.emitEvent({ type: 'reload', sessionId: session.id })
    return true
  }

  async compactSession(sessionId: string): Promise<boolean> {
    const session = sessions.get(sessionId)
    if (!session) return false
    if (this.runs.has(sessionId)) throw new Error('Wait for the current run to finish before compacting.')
    const cand = await this.helperModel(session.model)
    if (!cand) throw new Error('No model configured.')
    return this.compact(session, cand, undefined)
  }

  private async generateTitle(session: Session, text: string, cand: Candidate): Promise<void> {
    try {
      const helper = smallModel(settings.get(), cand)
      const title = (await this.oneShot(helper, TITLE_PROMPT, text.slice(0, 1500), undefined, { maxTokens: 40 })).replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0].slice(0, 70)
      if (title) { session.title = title; session.titled = true; sessions.save(session); this.emitEvent({ type: 'title', sessionId: session.id, title }); this.emitEvent({ type: 'session', session: metaOf(session) }) }
    } catch { /* keep the fallback title */ }
  }

  contextFor(sessionId: string) {
    const session = sessions.get(sessionId)
    if (!session) return null
    const s = settings.get()
    const cands = resolveModels({ settings: s, agent: { id: session.agent } as AgentConfig, session, explicit: null, hasImages: false, promptTokens: 0, userText: '' })
    const window = cands[0]?.info?.contextWindow ?? 128_000
    const ratio = session.tokenRatio ?? 1
    return quickSnapshot(session, window, 3500, Math.ceil(estimateChatTokens(toChatMessages(session), '', []) * ratio))
  }

  updateContextItems(sessionId: string, items: ContextItem[]): void {
    const s = sessions.get(sessionId)
    if (!s) return
    s.context = items
    sessions.save(s)
  }

  homeDir(): string { return homedir() }
  isDir(p: string): boolean { try { return statSync(p).isDirectory() } catch { return false } }
}

export const runtime = new AgentRuntime()
