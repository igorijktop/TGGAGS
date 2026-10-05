import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, Edit3, FilePen, Globe, MessageCircleQuestion, ShieldQuestion, SquareTerminal, X, Wrench, GitBranch, Image as ImageIcon, FolderOutput, Database } from 'lucide-react'
import type { PermissionRequest, QuestionRequest } from '@shared/ai'
import { api } from '../../lib/api'
import { cn, relativeTo } from '../../lib/util'
import { Button, Kbd, Popover } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { useWorkspace } from '../../stores/workspace'
import { DiffLines } from './ToolCards'

const CAT_ICON: Record<string, typeof Wrench> = { edit: FilePen, shell: SquareTerminal, git: GitBranch, web: Globe, subagent: Bot, image: ImageIcon, external_dir: FolderOutput, mcp: Database, external_api: Globe }

export function PermissionSheet({ req, index, total }: { req: PermissionRequest; index: number; total: number }) {
  const root = useWorkspace(s => s.root)
  const agents = useAi(s => s.agents)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [showFb, setShowFb] = useState(false)
  const busy = useRef(false)
  const reply = (decision: 'once' | 'session' | 'always' | 'deny', rule?: PermissionRequest['suggestions'][number]['rule']) => {
    if (busy.current) return
    busy.current = true
    void api.ai.answerPermission({ id: req.id, decision, rule, feedback: decision === 'deny' && feedback.trim() ? feedback.trim() : undefined }).finally(() => { busy.current = false })
  }
  useEffect(() => { busy.current = false; setFeedback(''); setShowFb(false) }, [req.id])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === 'Escape' && !more) { e.preventDefault(); e.stopPropagation(); reply('deny') }
      else if (e.key === 'Enter' && !typing && !more) { e.preventDefault(); e.stopPropagation(); reply(e.shiftKey ? 'session' : 'once') }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const Icon = CAT_ICON[req.category] ?? ShieldQuestion
  const agent = agents.find(a => a.id === req.agent)
  const pv = req.preview
  const resources = req.resources.filter(r => !(pv?.kind === 'command' && r === pv.command))
  return (
    <div className="sheet perm fade-in" role="alertdialog" aria-label="Permission request">
      <div className="sheet-head">
        <span className="sheet-ic warn"><Icon size={15} /></span>
        <div className="grow"><div className="sheet-title truncate">{req.title}</div>
          <div className="sheet-sub">{agent?.name ?? req.agent} wants to use <b>{req.tool}</b>{req.detail ? ` — ${req.detail}` : ''}</div></div>
        {total > 1 && <span className="badge">{index + 1} of {total}</span>}
      </div>
      {pv?.kind === 'diff' && <div className="sheet-preview"><div className="diff-file"><span className="link-file">{relativeTo(root, pv.path)}</span></div><DiffLines before={pv.before} after={pv.after} maxLines={40} /></div>}
      {pv?.kind === 'command' && <div className="sheet-preview"><div className="t-term selectable"><div className="t-cmd"><span className="prompt">$</span> {pv.command}</div>{pv.cwd && <div className="t-cmd subtle" style={{ fontSize: 11 }}>in {relativeTo(root, pv.cwd) || '.'}</div>}</div></div>}
      {pv?.kind === 'text' && <div className="sheet-preview"><pre className="t-pre selectable">{pv.text}</pre></div>}
      {resources.length > 0 && !pv && <div className="sheet-res">{resources.slice(0, 5).map(r => <code key={r}>{relativeTo(root, r)}</code>)}{resources.length > 5 && <span className="subtle">+{resources.length - 5} more</span>}</div>}
      {showFb && <div className="sheet-fb"><input className="input" autoFocus placeholder="Tell the agent what to do instead…" value={feedback} onChange={e => setFeedback(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); reply('deny') } }} /><Button variant="secondary" onClick={() => reply('deny')}>Deny with note</Button></div>}
      <div className="sheet-actions">
        <Button variant="primary" onClick={() => reply('once')}>Allow once <Kbd>Enter</Kbd></Button>
        <Button variant="secondary" onClick={() => reply('session')} tip="Allow the same kind of request for the rest of this chat">Allow for chat <Kbd>⇧↵</Kbd></Button>
        {req.suggestions.length > 0 && <>
          <Button variant="secondary" onClick={e => setMore(more ? null : e.currentTarget)}>Always allow<ChevronDown size={13} /></Button>
          {more && <Popover anchor={more} placement="top-start" onClose={() => setMore(null)} width={320}>
            <div className="menu-title">Always allow…</div>
            {req.suggestions.map(s => <button key={s.label} className="menu-item" onClick={() => { setMore(null); reply('always', s.rule) }}><span className="mi-icon"><Check size={14} /></span><span className="mi-label" style={{ whiteSpace: 'normal' }}>{s.label}</span></button>)}
            <div className="subtle" style={{ fontSize: 11, padding: '4px 10px 6px' }}>Saved as a permission rule. Edit anytime in Settings → Permissions.</div>
          </Popover>}
        </>}
        <span className="grow" />
        <Button variant="ghost" onClick={() => setShowFb(!showFb)} icon={Edit3} tip="Deny and tell the agent what to do instead" />
        <Button variant="ghost" onClick={() => reply('deny')}>Deny <Kbd>Esc</Kbd></Button>
      </div>
    </div>
  )
}

export function QuestionSheet({ req }: { req: QuestionRequest }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  useEffect(() => { setAnswers({}); setCustom({}) }, [req.id])
  const toggle = (qid: string, label: string, multiple?: boolean) => setAnswers(a => {
    const cur = a[qid] ?? []
    if (!multiple) return { ...a, [qid]: cur[0] === label ? [] : [label] }
    return { ...a, [qid]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
  })
  const ready = useMemo(() => req.questions.every(q => (answers[q.id]?.length ?? 0) > 0 || (custom[q.id] ?? '').trim()), [answers, custom, req.questions])
  const submit = () => {
    const out: Record<string, string | string[]> = {}
    for (const q of req.questions) {
      const list = [...(answers[q.id] ?? [])]
      const c = (custom[q.id] ?? '').trim()
      if (c) list.push(c)
      out[q.id] = q.multiple ? list : list.join(', ')
    }
    void api.ai.answerQuestion({ id: req.id, answers: out })
  }
  const cancel = () => void api.ai.answerQuestion({ id: req.id, cancelled: true })
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  return (
    <div className="sheet question fade-in" role="dialog" aria-label="Question from the agent">
      <div className="sheet-head"><span className="sheet-ic"><MessageCircleQuestion size={15} /></span><div className="grow"><div className="sheet-title">The agent has a question</div></div><button className="icon-btn sm" onClick={cancel} aria-label="Skip"><X size={14} /></button></div>
      <div className="q-list">
        {req.questions.map(q => <div key={q.id} className="q-item">
          {q.header && <div className="section-title">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          {q.options?.length ? <div className="q-opts">{q.options.map(o => {
            const on = (answers[q.id] ?? []).includes(o.label)
            return <button key={o.label} className={cn('q-opt', on && 'on')} onClick={() => toggle(q.id, o.label, q.multiple)}>
              <span className={cn(q.multiple ? 'checkbox' : 'radio', on && 'on')}>{on && (q.multiple ? <Check size={11} strokeWidth={3.5} /> : <i />)}</span>
              <span className="q-opt-main"><span>{o.label}</span>{o.description && <span className="subtle small">{o.description}</span>}</span></button>
          })}</div> : null}
          {(q.allowCustom !== false || !q.options?.length) && <input className="input" placeholder={q.options?.length ? 'Or type your own answer…' : 'Your answer…'} value={custom[q.id] ?? ''} onChange={e => setCustom(c => ({ ...c, [q.id]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && ready) submit() }} />}
        </div>)}
      </div>
      <div className="sheet-actions"><Button variant="primary" disabled={!ready} onClick={submit}>Send answer</Button><span className="grow" /><Button variant="ghost" onClick={cancel}>Skip <Kbd>Esc</Kbd></Button></div>
    </div>
  )
}
