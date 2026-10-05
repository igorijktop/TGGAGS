import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowDown, Brain, Search, Check, ChevronRight, Copy, FileDiff, GitFork, Hammer, ListChecks, Maximize2, Minimize2, MoreHorizontal, Pencil, Plus, RotateCcw, Sparkles, Trash2, Undo2, History, Download, Eraser, ShieldQuestion, Wand2 } from 'lucide-react'
import type { Message, Part, Session, ToolPart } from '@shared/ai'
import { api } from '../../lib/api'
import { cn, copyText, formatCost, formatDuration, formatTokens, timeAgo } from '../../lib/util'
import { Button, Dots, IconButton, Menu, Popover } from '../../components/ui'
import { Mascot } from '../../components/brand'
import { dialogs, toast, useUi } from '../../stores/ui'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'
import { useSettings } from '../../stores/settings'
import { useWorkspace } from '../../stores/workspace'
import { Markdown } from './Markdown'
import { ToolCard, TodoList, ToolGroupSummary } from './ToolCards'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { PermissionSheet, QuestionSheet } from './Sheets'
import { useChatModels } from './Selectors'

// ───────────── turn model ─────────────
interface Turn { id: string; user?: Message; assistants: Message[] }

function buildTurns(messages: Message[]): { turns: Turn[] } {
  const turns: Turn[] = []
  let cur: Turn | null = null
  for (const m of messages) {
    if (m.role === 'user' && !m.notice && !m.summary && !isHiddenUser(m)) { cur = { id: m.id, user: m, assistants: [] }; turns.push(cur); continue }
    if (!cur) { cur = { id: m.id, assistants: [] }; turns.push(cur) }
    cur.assistants.push(m)
  }
  return { turns }
}

const isHiddenUser = (m: Message) => m.role === 'user' && m.parts.length > 0 && m.parts.every(p => p.type === 'text' && p.synthetic)
const isReadTool = (n: string) => n === 'read' || n === 'list' || n === 'glob' || n === 'grep'

// ───────────── message pieces ─────────────
function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return <div className="reasoning">
    <button className="rs-head" onClick={() => setOpen(!open)}><ChevronRight size={13} className={cn('t-chev', open && 'open')} /><Brain size={13} />{streaming ? <>Thinking<Dots /></> : 'Thought process'}</button>
    {(open || streaming) && <div className={cn('rs-body selectable', streaming && !open && 'peek')}>{text}</div>}
  </div>
}

function ToolGroup({ parts, sessionId }: { parts: ToolPart[]; sessionId: string }) {
  const [open, setOpen] = useState(false)
  return <div className="tool-group">
    <button className="tg-head" onClick={() => setOpen(!open)}><ChevronRight size={13} className={cn('t-chev', open && 'open')} /><Search size={13} /><span className="truncate">{ToolGroupSummary({ parts })}</span></button>
    {open && <div className="tg-body">{parts.map(p => <ToolCard key={p.id} part={p} sessionId={sessionId} />)}</div>}
  </div>
}


const AssistantBody = memo(function AssistantBody({ msg, sessionId, live }: { msg: Message; sessionId: string; live: boolean }) {
  const showReasoning = useSettings(s => s.settings.ai.showReasoning)
  const blocks: ReactNode[] = []
  const parts = msg.parts
  for (let i = 0; i < parts.length; i++) {
    const p: Part = parts[i]
    if (p.type === 'text') {
      if (p.synthetic || !p.text.trim()) continue
      blocks.push(<Markdown key={i} text={p.text} streaming={live && i === parts.length - 1} className="msg-text" />)
    } else if (p.type === 'reasoning') {
      if (showReasoning && !p.redacted) blocks.push(<Reasoning key={i} text={p.text} streaming={live && i === parts.length - 1} />)
    } else if (p.type === 'tool') {
      // collapse runs of finished read-only tools
      const run: ToolPart[] = [p]
      let j = i + 1
      while (j < parts.length && parts[j].type === 'tool' && isReadTool((parts[j] as ToolPart).name) && isReadTool(p.name)) { run.push(parts[j] as ToolPart); j++ }
      if (run.length >= 3 && run.every(t => t.state === 'completed' || t.state === 'error')) { blocks.push(<ToolGroup key={p.id} parts={run} sessionId={sessionId} />); i = j - 1 }
      else blocks.push(<ToolCard key={p.id} part={p} sessionId={sessionId} />)
    } else if (p.type === 'image') {
      blocks.push(<img key={i} className="msg-img" src={`data:${p.mime};base64,${p.data}`} alt={p.name ?? 'image'} />)
    }
  }
  return <>{blocks}{msg.error && <div className="msg-error"><AlertCircle size={14} /><span className="selectable">{msg.error}</span></div>}</>
})

function UserMessage({ msg, sessionId, running }: { msg: Message; sessionId: string; running: boolean }) {
  const text = msg.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => (p as { text: string }).text).join('\n')
  const images = msg.parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image')
  const [copied, setCopied] = useState(false)
  const edit = async () => {
    if (running) { toast.info('Stop the current run first.'); return }
    const ok = await dialogs.confirm({ title: 'Edit and resend?', message: 'This message and everything after it will be removed from the chat. File changes already made stay on disk — use Undo to revert them.', confirmLabel: 'Edit message' })
    if (!ok) return
    const s = await api.ai.sessions.truncateAt(sessionId, msg.id)
    if (s) { useAi.setState(st => ({ data: { ...st.data, [sessionId]: s } })); useAi.getState().setDraft(sessionId, { text }); window.dispatchEvent(new Event('tgg:focus-composer')) }
  }
  const fork = async () => { const s = await api.ai.sessions.fork(sessionId, msg.id); if (s) { await useAi.getState().loadSessions(); await useAi.getState().open(s.id); toast.success('Forked into a new chat.') } }
  return <div className="msg user">
    <div className="bubble">
      {images.length > 0 && <div className="bubble-imgs">{images.map((im, i) => <img key={i} src={`data:${im.mime};base64,${im.data}`} alt={im.name ?? 'image'} />)}</div>}
      <div className="bubble-text selectable">{text}</div>
    </div>
    <div className="msg-actions">
      <IconButton icon={copied ? Check : Copy} size="sm" tip="Copy" onClick={() => { void copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) }} />
      <IconButton icon={Pencil} size="sm" tip="Edit and resend" onClick={() => void edit()} />
      <IconButton icon={GitFork} size="sm" tip="Fork chat from here" onClick={() => void fork()} />
    </div>
  </div>
}

function TurnFooter({ turn, session, last, running }: { turn: Turn; session: Session; last: boolean; running: boolean }) {
  const changes = useAi(s => s.changes[session.id]) ?? []
  const ids = new Set(turn.assistants.map(m => m.id))
  const mine = changes.filter(c => c.messageId && ids.has(c.messageId))
  const usage = turn.assistants.reduce((a, m) => ({ i: a.i + (m.usage?.input ?? 0), o: a.o + (m.usage?.output ?? 0), c: a.c + (m.usage?.cost ?? 0) }), { i: 0, o: 0, c: 0 })
  const dur = turn.user && turn.assistants.length ? turn.assistants[turn.assistants.length - 1].ts - turn.user.ts : 0
  const text = turn.assistants.flatMap(m => m.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => (p as { text: string }).text)).join('\n\n')
  const [copied, setCopied] = useState(false)
  const undo = async () => {
    if (!turn.user) return
    const later = !last
    if (later && !(await dialogs.confirm({ title: 'Undo this and later turns?', message: 'File changes made in this turn and every turn after it will be reverted.', confirmLabel: 'Undo', danger: true }))) return
    const r = await api.ai.changes.undoFromTurn(session.id, turn.user.id)
    toast[r.reverted ? 'success' : 'info'](r.reverted ? `Reverted ${r.files.length} file(s).` : 'Nothing to undo.')
  }
  const retry = async () => {
    if (!turn.user || running) return
    const t = turn.user.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => (p as { text: string }).text).join('\n')
    const s = await api.ai.sessions.truncateAt(session.id, turn.user.id)
    if (s) { useAi.setState(st => ({ data: { ...st.data, [session.id]: s } })); await useAi.getState().send(t, { sessionId: session.id }) }
  }
  const added = mine.reduce((n, c) => n + c.added, 0), removed = mine.reduce((n, c) => n + c.removed, 0)
  if (!turn.assistants.length) return null
  return <div className="turn-foot">
    {mine.length > 0 && <>
      <button className="foot-chip changes" onClick={() => useEditor.getState().openPage('changes', { sessionId: session.id }, 'Changes')}><FileDiff size={13} />{mine.length} file{mine.length > 1 ? 's' : ''} changed <span className="ok">+{added}</span> <span className="err">−{removed}</span></button>
      <button className="foot-btn" onClick={() => void undo()} data-tip="Revert the file changes of this turn"><Undo2 size={13} />Undo</button>
    </>}
    <span className="grow" />
    {(usage.i + usage.o > 0) && <span className="foot-meta" data-tip={`${usage.i.toLocaleString()} input · ${usage.o.toLocaleString()} output tokens`}>{formatTokens(usage.i + usage.o)} tokens{usage.c > 0 && ` · ${formatCost(usage.c)}`}{dur > 2000 && ` · ${formatDuration(dur)}`}</span>}
    {text && <IconButton icon={copied ? Check : Copy} size="sm" tip="Copy response" onClick={() => { void copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) }} />}
    {!running && turn.user && <IconButton icon={RotateCcw} size="sm" tip="Retry" onClick={() => void retry()} />}
  </div>
}

function CompactionNote({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false)
  const text = msg.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
  return <div className="note-line"><button onClick={() => setOpen(!open)}><span className="nl-rule" /><span className="nl-text"><Wand2 size={12} /> Earlier messages were summarised to save space<ChevronRight size={12} className={cn('t-chev', open && 'open')} /></span><span className="nl-rule" /></button>{open && <div className="nl-body selectable">{text}</div>}</div>
}

// ───────────── empty state ─────────────
const SUGGESTIONS = [
  { icon: Search, title: 'Explain this project', text: 'Give me a tour of this project: what it does, how it is structured, and how to run it.' },
  { icon: AlertCircle, title: 'Find and fix bugs', text: 'Look for bugs or risky code in this project. Explain what you find and fix the clear ones.' },
  { icon: ListChecks, title: 'Write tests', text: 'Find the most important untested code in this project and write tests for it, then run them.' },
  { icon: Hammer, title: 'Review my changes', text: 'Review my uncommitted changes and point out problems before I commit.' }
]

function EmptyChat() {
  const models = useChatModels()
  const root = useWorkspace(s => s.root)
  const name = useWorkspace(s => s.name)
  return <div className="chat-empty fade-in">
    <Mascot size={64} />
    <h2 className="serif">{root ? <>Let’s work on <em>{name}</em></> : 'What shall we build?'}</h2>
    <p>{models.length ? 'Ask a question, describe a change, or hand over a whole task. I can read, search, edit and run your project — and I’ll ask before anything risky.' : 'Connect an AI provider to get started. Your keys stay on this computer.'}</p>
    {!models.length && <Button variant="primary" size="lg" icon={Sparkles} onClick={() => useEditor.getState().openPage('models', undefined, 'Models & providers')}>Connect a model</Button>}
    {models.length > 0 && root && <div className="suggest-grid">{SUGGESTIONS.map(s => <button key={s.title} className="suggest" onClick={() => void useAi.getState().send(s.text)}><s.icon size={15} /><span>{s.title}</span></button>)}</div>}
  </div>
}

// ───────────── header ─────────────
function Header({ session }: { session: Session | null }) {
  const sessions = useAi(s => s.sessions)
  const active = useAi(s => s.active)
  const focus = useUi(s => s.chatFocus)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const recent = sessions.slice(0, 12)
  const title = session?.title ?? 'New chat'
  const rename = async () => { if (!session) return; const t = await dialogs.prompt({ title: 'Rename chat', initial: session.title, confirmLabel: 'Rename' }); if (t?.trim()) { await api.ai.sessions.rename(session.id, t.trim()); void useAi.getState().loadSessions(); useAi.setState(s => ({ data: { ...s.data, [session.id]: { ...s.data[session.id], title: t.trim() } } })) } }
  const del = async () => { if (!session) return; if (await dialogs.confirm({ title: 'Delete this chat?', message: 'The conversation is removed. File changes already made are not reverted.', confirmLabel: 'Delete', danger: true })) await useAi.getState().removeSession(session.id) }
  return <div className="chat-head">
    <button className="ch-title" onClick={e => setEl(el ? null : e.currentTarget)}><span className="truncate">{title}</span><ChevronRight size={13} className="ch-caret" /></button>
    <span className="grow" />
    <IconButton icon={Plus} tip="New chat" kbd="Ctrl+Shift+L" onClick={() => void useAi.getState().newChat()} />
    <IconButton icon={focus ? Minimize2 : Maximize2} tip={focus ? 'Back to the editor' : 'Focus on chat'} onClick={() => useUi.getState().set({ chatFocus: !focus })} />
    <IconButton icon={MoreHorizontal} tip="More" active={!!more} onClick={e => setMore(more ? null : e.currentTarget)} />
    {el && <Popover anchor={el} placement="bottom-start" onClose={() => setEl(null)} width={330}>
      <div className="menu-title">Recent chats</div>
      {recent.length === 0 && <div className="pal-empty">No chats yet.</div>}
      {recent.map(s => <button key={s.id} className={cn('menu-item', s.id === active && 'hl')} onClick={() => { setEl(null); void useAi.getState().open(s.id) }}>
        <span className="mi-icon">{s.running ? <span className="status-dot run" /> : <History size={14} />}</span><span className="mi-label truncate">{s.title}</span><span className="mi-hint">{timeAgo(s.updatedAt)}</span></button>)}
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => { setEl(null); useUi.getState().showView('ai') }}><span className="mi-icon"><History size={15} /></span><span className="mi-label">All chats…</span></button>
    </Popover>}
    {more && <Menu anchor={more} placement="bottom-end" onClose={() => setMore(null)} items={[
      { label: 'Rename', icon: Pencil, disabled: !session, onClick: () => void rename() },
      { label: 'Copy as Markdown', icon: Download, disabled: !session, onClick: async () => { await copyText(await api.ai.sessions.exportMarkdown(session!.id)); toast.success('Chat copied as Markdown.') } },
      { label: 'Compact conversation', icon: Eraser, disabled: !session, onClick: async () => { const ok = await api.ai.compact(session!.id); toast[ok ? 'success' : 'info'](ok ? 'Conversation compacted.' : 'Nothing to compact yet.') } },
      { label: 'Review file changes', icon: FileDiff, disabled: !session, onClick: () => useEditor.getState().openPage('changes', { sessionId: session!.id }, 'Changes') },
      { separator: true },
      { label: 'Delete chat', icon: Trash2, danger: true, disabled: !session, onClick: () => void del() }
    ]} />}
  </div>
}

// ───────────── footer widgets ─────────────
function TasksCard({ sessionId }: { sessionId: string }) {
  const todos = useAi(s => s.data[sessionId]?.todos) ?? []
  const [open, setOpen] = useState(true)
  if (!todos.length || todos.every(t => t.status === 'completed')) return null
  const done = todos.filter(t => t.status === 'completed').length
  const cur = todos.find(t => t.status === 'in_progress')
  return <div className="tasks-card">
    <button className="tc-head" onClick={() => setOpen(!open)}><ListChecks size={14} /><span className="truncate">{cur ? cur.content : 'Tasks'}</span><span className="grow" /><span className="tc-count">{done}/{todos.length}</span><ChevronRight size={13} className={cn('t-chev', open && 'open')} /></button>
    <div className="tc-bar"><i style={{ width: `${(done / todos.length) * 100}%` }} /></div>
    {open && <TodoList todos={todos} compact />}
  </div>
}

function ChangesBar({ sessionId }: { sessionId: string }) {
  const changes = useAi(s => s.changes[sessionId]) ?? []
  const running = useAi(s => !!s.running[sessionId])
  if (!changes.length || running) return null
  const a = changes.reduce((n, c) => n + c.added, 0), r = changes.reduce((n, c) => n + c.removed, 0)
  return <div className="changes-bar">
    <FileDiff size={14} /><span><b>{changes.length}</b> file{changes.length > 1 ? 's' : ''} changed <span className="ok">+{a}</span> <span className="err">−{r}</span></span><span className="grow" />
    <Button size="sm" variant="secondary" onClick={() => useEditor.getState().openPage('changes', { sessionId }, 'Changes')}>Review</Button>
    <Button size="sm" variant="ghost" onClick={async () => { if (await dialogs.confirm({ title: 'Undo all changes?', message: `Revert ${changes.length} file(s) to how they were before the agent touched them.`, confirmLabel: 'Undo all', danger: true })) { const x = await api.ai.changes.undoFromTurn(sessionId, null); toast.success(`Reverted ${x.files.length} file(s).`) } }}>Undo all</Button>
    <Button size="sm" variant="ghost" onClick={() => void api.ai.changes.accept(sessionId).then(() => useAi.setState(s => ({ changes: { ...s.changes, [sessionId]: [] } })))} data-tip="Keep the changes and hide this bar">Keep</Button>
  </div>
}

function StatusLine({ sessionId }: { sessionId: string }) {
  const st = useAi(s => s.status[sessionId])
  const running = useAi(s => !!s.running[sessionId])
  if (!running) return null
  const label = ({ thinking: 'Thinking', tool: st?.detail || 'Working', waiting_permission: 'Waiting for your approval', waiting_question: 'Waiting for your answer', compacting: 'Summarising the conversation', retrying: st?.detail || 'Retrying', idle: 'Working' } as Record<string, string>)[st?.status ?? 'thinking']
  return <div className="status-line"><Dots /><span>{label}</span></div>
}

// ───────────── the panel ─────────────
export function ChatPanel() {
  const active = useAi(s => s.active)
  const session = useAi(s => (s.active ? s.data[s.active] : undefined)) ?? null
  const running = useAi(s => (s.active ? !!s.running[s.active] : false))
  const permissions = useAi(s => s.permissions)
  const questions = useAi(s => s.questions)
  const children = useAi(s => s.children)
  const sessionsMeta = useAi(s => s.sessions)
  const error = useAi(s => (s.active ? s.errors[s.active] : undefined))
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const messages = session?.messages ?? []
  const { turns } = useMemo(() => buildTurns(messages), [messages])

  // pending requests that belong to this chat (or its sub-agents); others get a hint
  const mine = (sid: string) => sid === active || (active ? !!children[active]?.some(c => c.id === sid) : false)
  const perms = permissions.filter(p => mine(p.sessionId))
  const qs = questions.filter(q => mine(q.sessionId))
  const elsewhere = [...permissions, ...questions].filter(r => !mine(r.sessionId))

  useLayoutEffect(() => { if (stick.current) { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight } })
  useEffect(() => { stick.current = true; setAway(false); requestAnimationFrame(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }) }, [active])
  const onScroll = () => {
    const el = scroller.current; if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    setAway(!near)
  }
  const toBottom = () => { const el = scroller.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); stick.current = true; setAway(false) } }
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && running && !perms.length && !qs.length && document.activeElement?.tagName === 'TEXTAREA' && (document.activeElement as HTMLElement).classList.contains('composer-input')) { void useAi.getState().abort() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [running, perms.length, qs.length])

  const lastTurn = turns[turns.length - 1]
  return (
    <div className="chat">
      <Header session={session} />
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {turns.length === 0 ? <EmptyChat /> : <div className="chat-col">
          {turns.map((t, ti) => {
            const isLast = ti === turns.length - 1
            return <div className="turn" key={t.id}>
              {t.user && <UserMessage msg={t.user} sessionId={session!.id} running={running} />}
              {t.assistants.map((m, mi) => m.summary
                ? <CompactionNote key={m.id} msg={m} />
                : isHiddenUser(m) ? null
                : m.role === 'user' || m.notice
                  ? <div key={m.id} className="note-line"><span className="nl-text selectable">{m.parts.map(p => (p.type === 'text' ? p.text : '')).join(' ')}</span></div>
                  : <div key={m.id} className="msg assistant"><AssistantBody msg={m} sessionId={session!.id} live={running && isLast && mi === t.assistants.length - 1} /></div>)}
              {!(running && isLast) && <TurnFooter turn={t} session={session!} last={isLast} running={running} />}
            </div>
          })}
          {running && <StatusLine sessionId={active!} />}
          {error && !running && <div className="msg-error big"><AlertCircle size={15} /><span className="selectable grow">{error}</span>{lastTurn?.user && <Button size="sm" variant="secondary" onClick={() => { useAi.getState().dismissError(active!); const t = lastTurn.user!.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => (p as { text: string }).text).join('\n'); void api.ai.sessions.truncateAt(active!, lastTurn.user!.id).then(s => { if (s) { useAi.setState(st => ({ data: { ...st.data, [active!]: s } })); void useAi.getState().send(t, { sessionId: active! }) } }) }}>Retry</Button>}<IconButton icon={Check} size="sm" tip="Dismiss" onClick={() => useAi.getState().dismissError(active!)} /></div>}
        </div>}
        {away && turns.length > 0 && <button className="to-bottom" onClick={toBottom} aria-label="Scroll to latest"><ArrowDown size={15} /></button>}
      </div>
      <div className="chat-foot">
        {elsewhere.length > 0 && <div className="elsewhere"><ShieldQuestion size={14} />Another chat is waiting for your approval.<button className="link-btn" onClick={() => { const r = elsewhere[0]; const sid = 'sessionId' in r ? r.sessionId : ''; const meta = sessionsMeta.find(s => s.id === sid) ?? Object.values(children).flat().find(s => s.id === sid); void useAi.getState().open(meta?.parentId ?? sid) }}>Open</button></div>}
        {active && !perms.length && !qs.length && <TasksCard sessionId={active} />}
        {active && !perms.length && !qs.length && <ChangesBar sessionId={active} />}
        {perms.length > 0 ? <PermissionSheet req={perms[0]} index={0} total={perms.length} />
          : qs.length > 0 ? <QuestionSheet req={qs[0]} />
            : <>
              <ContextBar sessionId={active} />
              <Composer sessionId={active} autoFocus />
            </>}
      </div>
    </div>
  )
}
