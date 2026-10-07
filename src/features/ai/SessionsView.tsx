import { useMemo, useState } from 'react'
import { kbHint } from '../../lib/commands'
import { Bot, Download, GitFork, MessageSquarePlus, Pencil, Search, Trash2, MessagesSquare } from 'lucide-react'
import type { SessionMeta } from '@shared/ai'
import { api } from '../../lib/api'
import { cn, copyText, timeAgo } from '../../lib/util'
import { Button, EmptyState, IconButton, useContextMenu } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { dialogs, toast, useUi } from '../../stores/ui'
import { focusComposer, revealChat } from '../../lib/chat-nav'

function bucket(ts: number): string {
  const d = new Date(ts), n = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(n) - day(d)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return 'Previous 7 days'
  if (diff < 31) return 'Previous 30 days'
  return 'Older'
}

export function SessionsView() {
  const sessions = useAi(s => s.sessions)
  const active = useAi(s => s.active)
  const [q, setQ] = useState('')
  const ctx = useContextMenu()
  const groups = useMemo(() => {
    const list = sessions.filter(s => !q || (s.title + ' ' + s.preview).toLowerCase().includes(q.toLowerCase()))
    const out: { name: string; items: SessionMeta[] }[] = []
    for (const s of list) { const b = bucket(s.updatedAt); const g = out.find(x => x.name === b); if (g) g.items.push(s); else out.push({ name: b, items: [s] }) }
    return out
  }, [sessions, q])
  const open = (id: string) => { void useAi.getState().open(id); revealChat() }
  const rename = async (s: SessionMeta) => { const t = await dialogs.prompt({ title: 'Rename chat', initial: s.title, confirmLabel: 'Rename' }); if (t?.trim()) { await api.ai.sessions.rename(s.id, t.trim()); await useAi.getState().loadSessions() } }
  const del = async (s: SessionMeta) => { if (await dialogs.confirm({ title: `Delete “${s.title}”?`, message: 'This chat is removed for good. File changes already made are not reverted.', confirmLabel: 'Delete', danger: true })) await useAi.getState().removeSession(s.id) }
  return <>
    <div className="sb-head"><h2>AI Chats</h2><IconButton icon={MessageSquarePlus} tip="New chat" kbd={kbHint('ai.newChat')} size="sm" onClick={() => { void useAi.getState().newChat(); revealChat(); focusComposer() }} /></div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><div className="search-input"><Search size={13} /><input className="input sm" placeholder="Search chats…" value={q} onChange={e => setQ(e.target.value)} /></div></div>
    <div className="sb-body" style={{ paddingBottom: 16 }}>
      {sessions.length === 0 && <EmptyState icon={MessagesSquare} title="No chats yet" text="Chats for this project show up here, so you can pick up where you left off."><Button variant="primary" onClick={() => { void useAi.getState().newChat(); revealChat(); focusComposer() }}>Start a chat</Button></EmptyState>}
      {sessions.length > 0 && groups.length === 0 && <div className="subtle" style={{ padding: 20, textAlign: 'center' }}>No chats match “{q}”.</div>}
      {groups.map(g => <div key={g.name}>
        <div className="section-title" style={{ padding: '10px 16px 4px' }}>{g.name}</div>
        {g.items.map(s => <div key={s.id} className={cn('sess-row', s.id === active && 'active')} onClick={() => open(s.id)} onContextMenu={e => ctx(e, [
          { label: 'Open', onClick: () => open(s.id) }, { label: 'Rename', icon: Pencil, onClick: () => void rename(s) },
          { label: 'Fork', icon: GitFork, onClick: async () => { const f = await api.ai.sessions.fork(s.id); if (f) { await useAi.getState().loadSessions(); open(f.id) } } },
          { label: 'Copy as Markdown', icon: Download, onClick: async () => { await copyText(await api.ai.sessions.exportMarkdown(s.id)); toast.success('Chat copied as Markdown.') } },
          { separator: true }, { label: 'Delete', icon: Trash2, danger: true, onClick: () => void del(s) }])}>
          <span className="sess-ic">{s.running ? <span className="status-dot run" /> : <Bot size={14} />}</span>
          <span className="sess-main"><span className="sess-title truncate">{s.title}</span><span className="sess-sub truncate">{s.preview || `${s.messageCount} messages`}</span></span>
          <span className="sess-time">{timeAgo(s.updatedAt)}</span>
          <button className="sess-del" onClick={e => { e.stopPropagation(); void del(s) }} aria-label="Delete chat"><Trash2 size={13} /></button>
        </div>)}
      </div>)}
    </div>
  </>
}
