import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Clock, ExternalLink, GitMerge, GitPullRequest, MessageSquare, Sparkles } from 'lucide-react'
import type { GhCheck, GhComment, GhPull } from '@shared/media'
import { api } from '../../lib/api'
import { cn, timeAgo } from '../../lib/util'
import { Badge, Button, EmptyState, Spinner, MenuButton } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { dialogs, toast, useUi } from '../../stores/ui'
import { Markdown } from '../ai/Markdown'
import { FileIcon } from '../../lib/icons'
import { basename } from '../../lib/util'

interface Data { pull: GhPull; files: { path: string; status: string; additions: number; deletions: number; patch?: string }[]; comments: GhComment[]; checks: GhCheck[] }

function Patch({ text }: { text: string }) {
  return <div className="difflines selectable">{text.split('\n').map((l, i) => { const k = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'; return <div key={i} className={cn('dl', k)}>{k === 'hunk' ? l : <><span className="dl-sign">{k === 'add' ? '+' : k === 'del' ? '−' : ''}</span><span className="dl-text">{l.slice(1) || ' '}</span></>}</div> })}</div>
}

export function PullPage({ number }: { number: number }) {
  const [d, setD] = useState<Data | null | undefined>(undefined)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [comment, setComment] = useState('')
  const load = () => void api.github.pull(number).then(setD).catch(() => setD(null))
  useEffect(() => { setD(undefined); load() }, [number]) // eslint-disable-line react-hooks/exhaustive-deps
  if (d === undefined) return <div className="center grow"><Spinner size={18} /></div>
  if (d === null) return <div className="page-scroll"><EmptyState icon={GitPullRequest} title="Pull request not found" text="Check that you’re signed in to GitHub and the project has a GitHub remote." /></div>
  const p = d.pull
  const merge = async (method: 'merge' | 'squash' | 'rebase') => { if (!(await dialogs.confirm({ title: `${method[0].toUpperCase() + method.slice(1)} pull request #${p.number}?`, message: `${p.head} will be merged into ${p.base}.`, confirmLabel: 'Merge' }))) return; try { await api.github.mergePull(p.number, method); toast.success('Merged.'); load() } catch (e) { toast.error((e as Error).message) } }
  const review = () => { useUi.getState().set({ aiVisible: true }); void useAi.getState().send(`Review pull request #${p.number} “${p.title}” (${p.head} → ${p.base}). Use the github tool to read its files and comments. Point out bugs, risks and missing tests, ordered by severity. Do not change any files.`) }
  const post = async () => { if (!comment.trim()) return; try { await api.github.comment(p.number, comment.trim()); setComment(''); load() } catch (e) { toast.error((e as Error).message) } }
  const state = p.merged ? 'merged' : p.state
  return <div className="page-scroll"><div className="page narrow">
    <div className="page-head"><div><div className="row gap8"><Badge kind={state === 'open' ? 'success' : state === 'merged' ? 'accent' : 'danger'}>{p.draft ? 'Draft' : state}</Badge><span className="subtle small">#{p.number} · {p.author} · {timeAgo(p.updated)}</span></div><h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>{p.title}</h1><p className="page-sub"><span className="mono">{p.head}</span> → <span className="mono">{p.base}</span> · {p.changedFiles ?? d.files.length} files · <span className="ok">+{p.additions ?? 0}</span> <span className="err">−{p.deletions ?? 0}</span></p></div>
      <div className="row gap8"><Button variant="soft" icon={Sparkles} onClick={review}>Review with AI</Button><Button icon={ExternalLink} onClick={() => void api.fs.openExternal(p.url)}>GitHub</Button>
        {p.state === 'open' && !p.merged && <MenuButton variant="primary" icon={GitMerge} placement="bottom-end" items={[{ label: 'Create a merge commit', onClick: () => void merge('merge') }, { label: 'Squash and merge', onClick: () => void merge('squash') }, { label: 'Rebase and merge', onClick: () => void merge('rebase') }]}>Merge</MenuButton>}</div></div>
    {p.mergeable === false && <div className="scm-banner err"><span>This branch has conflicts with {p.base} that must be resolved before merging.</span></div>}
    {p.body && <div className="card" style={{ padding: '14px 18px' }}><Markdown text={p.body} /></div>}
    {d.checks.length > 0 && <div className="card" style={{ padding: '6px 4px' }}>{d.checks.map(c => <div key={c.name} className="list-row" style={{ cursor: c.url ? 'pointer' : 'default' }} onClick={() => c.url && void api.fs.openExternal(c.url)}>{c.status !== 'completed' ? <Clock size={14} className="warn" /> : c.conclusion === 'success' ? <CircleCheck size={14} className="ok" /> : c.conclusion === 'skipped' || c.conclusion === 'neutral' ? <Clock size={14} className="subtle" /> : <CircleX size={14} className="err" />}<span className="grow truncate">{c.name}</span><span className="subtle small">{c.status === 'completed' ? c.conclusion : c.status}</span></div>)}</div>}
    <div className="section-title" style={{ marginTop: 6 }}>Files changed</div>
    <div className="card" style={{ overflow: 'hidden' }}>{d.files.map(f => <div key={f.path}><div className="cc-top" onClick={() => setOpen(o => ({ ...o, [f.path]: !o[f.path] }))}><FileIcon name={basename(f.path)} size={16} /><span className="cc-name truncate">{f.path}</span><Badge>{f.status}</Badge><span className="grow" /><span className="ok small">+{f.additions}</span><span className="err small">−{f.deletions}</span></div>{open[f.path] && (f.patch ? <Patch text={f.patch} /> : <div className="subtle small" style={{ padding: 12 }}>No textual diff available (binary or too large).</div>)}</div>)}</div>
    <div className="section-title" style={{ marginTop: 6 }}>Conversation</div>
    {d.comments.map((c, i) => <div key={i} className="card" style={{ padding: '12px 16px' }}><div className="small muted" style={{ marginBottom: 6 }}><b style={{ color: 'var(--fg)' }}>{c.author}</b> · {timeAgo(c.created)}</div><Markdown text={c.body} /></div>)}
    <div className="card" style={{ padding: 12 }}><textarea className="textarea" rows={3} placeholder="Leave a comment…" value={comment} onChange={e => setComment(e.target.value)} style={{ marginBottom: 8 }} /><div className="row"><MessageSquare size={14} className="subtle" /><span className="grow" /><Button variant="primary" disabled={!comment.trim()} onClick={() => void post()}>Comment</Button></div></div>
  </div></div>
}
