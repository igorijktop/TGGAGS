import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleDot, CircleX, Clock, ExternalLink, GitPullRequest, GitPullRequestDraft, LogOut, MessageSquare, Plus, RefreshCw, KeyRound, Download, Lock, Play } from 'lucide-react'
import type { GhIssue, GhPull, GhRun, GhUser } from '@shared/media'
import { api } from '../../lib/api'
import { timeAgo } from '../../lib/util'
import { Button, EmptyState, IconButton, Segmented, Spinner, Badge } from '../../components/ui'
import { GithubIcon } from '../../components/brand'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { dialogs, toast } from '../../stores/ui'
import { openWorkspace } from '../../commands'
import { Markdown } from '../ai/Markdown'

type Tab = 'pulls' | 'issues' | 'runs' | 'repos'
type Status = { authenticated: boolean; user?: GhUser; repo?: { owner: string; repo: string } | null; error?: string }

function SignIn({ onDone }: { onDone(): void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => { setBusy(true); setErr(null); const r = await api.github.setToken(token.trim()).catch(e => ({ ok: false, error: (e as Error).message })); setBusy(false); if (r.ok) onDone(); else setErr(r.error ?? 'That token was not accepted.') }
  return <div className="gh-signin">
    <div className="gh-mark"><GithubIcon size={28} /></div>
    <h3 className="serif">Connect GitHub</h3>
    <p>Browse and create pull requests and issues, watch workflow runs and let the agent use GitHub — all from here. Your token is stored encrypted on this computer.</p>
    <input className="input" type="password" placeholder="Personal access token (ghp_… or github_pat_…)" value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && token.trim()) void go() }} />
    {err && <div className="msg-error"><CircleAlert size={14} /><span>{err}</span></div>}
    <Button variant="primary" icon={KeyRound} disabled={!token.trim() || busy} onClick={() => void go()}>{busy ? 'Checking…' : 'Connect'}</Button>
    <button className="link-btn small" onClick={() => void api.fs.openExternal('https://github.com/settings/tokens/new?scopes=repo,workflow&description=TGGAGS')}>Create a token on GitHub →</button>
    <p className="subtle small">Needs the <b>repo</b> scope (and <b>workflow</b> to see Actions).</p>
  </div>
}

const runIcon = (r: GhRun) => (r.status !== 'completed' ? <Clock size={14} className="warn" /> : r.conclusion === 'success' ? <CircleCheck size={14} className="ok" /> : r.conclusion === 'cancelled' || r.conclusion === 'skipped' ? <CircleDot size={14} className="subtle" /> : <CircleX size={14} className="err" />)

export function GithubView() {
  const [st, setSt] = useState<Status | null>(null)
  const [tab, setTab] = useState<Tab>('pulls')
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pulls, setPulls] = useState<GhPull[]>([])
  const [issues, setIssues] = useState<GhIssue[]>([])
  const [runs, setRuns] = useState<GhRun[]>([])
  const [repos, setRepos] = useState<Awaited<ReturnType<typeof api.github.repos>>>([])
  const git = useGit(s => s.status)
  const refreshStatus = useCallback(() => void api.github.status().then(setSt).catch(e => setSt({ authenticated: false, error: (e as Error).message })), [])
  useEffect(refreshStatus, [refreshStatus])
  const load = useCallback(async () => {
    if (!st?.authenticated) return
    setLoading(true); setErr(null)
    try {
      if (tab === 'pulls' && st.repo) setPulls(await api.github.pulls(state))
      if (tab === 'issues' && st.repo) setIssues(await api.github.issues(state))
      if (tab === 'runs' && st.repo) setRuns(await api.github.runs())
      if (tab === 'repos') setRepos(await api.github.repos())
    } catch (e) { setErr((e as Error).message.replace(/^Error invoking.*?: /, '')) } finally { setLoading(false) }
  }, [st, tab, state])
  useEffect(() => { void load() }, [load])

  const newPull = async () => {
    const base = await api.github.defaultBranch().catch(() => 'main')
    const head = git?.branch ?? ''
    if (!head) { toast.warn('Switch to a branch first.'); return }
    const title = await dialogs.prompt({ title: 'New pull request', message: `${head} → ${base}. Make sure the branch is pushed.`, placeholder: 'Title', confirmLabel: 'Create' })
    if (!title?.trim()) return
    try { const p = await api.github.createPull({ title: title.trim(), body: '', head, base }); toast.success(`Created #${p.number}`); void load(); useEditor.getState().openPage('github-pr', { number: p.number }, `#${p.number}`) } catch (e) { toast.error((e as Error).message) }
  }
  const newIssue = async () => {
    const title = await dialogs.prompt({ title: 'New issue', placeholder: 'Title', confirmLabel: 'Create' }); if (!title?.trim()) return
    try { const i = await api.github.createIssue(title.trim(), ''); toast.success(`Created #${i.number}`); void load() } catch (e) { toast.error((e as Error).message) }
  }
  const openIssue = async (i: GhIssue) => {
    const d = await api.github.issue(i.number)
    await dialogs.custom({ title: `#${d.issue.number} ${d.issue.title}`, wide: true, render: () => <div className="col gap12"><div className="row gap8"><Badge kind={d.issue.state === 'open' ? 'success' : 'danger'}>{d.issue.state}</Badge><span className="subtle small">{d.issue.author} · {timeAgo(d.issue.updated)}</span><span className="grow" /><Button size="sm" icon={ExternalLink} onClick={() => void api.fs.openExternal(d.issue.url)}>Open on GitHub</Button></div>
      <Markdown text={d.issue.body || '*No description.*'} />{d.comments.map((c, k) => <div key={k} className="card" style={{ padding: 12 }}><div className="small muted" style={{ marginBottom: 6 }}><b style={{ color: 'var(--fg)' }}>{c.author}</b> · {timeAgo(c.created)}</div><Markdown text={c.body} /></div>)}</div> })
  }

  if (!st) return <div className="center grow"><Spinner size={18} /></div>
  if (!st.authenticated) return <><div className="sb-head"><h2>GitHub</h2></div><div className="sb-body"><SignIn onDone={refreshStatus} /></div></>
  return <>
    <div className="sb-head"><h2>GitHub</h2><IconButton icon={RefreshCw} size="sm" tip="Refresh" className={loading ? 'spin-anim' : ''} onClick={() => void load()} /><IconButton icon={LogOut} size="sm" tip={`Sign out ${st.user?.login ?? ''}`} onClick={async () => { await api.github.logout(); refreshStatus() }} /></div>
    <div className="gh-user">{st.user?.avatar ? <img src={st.user.avatar} alt="" /> : <GithubIcon size={20} />}<div className="grow" style={{ minWidth: 0 }}><b className="truncate" style={{ display: 'block' }}>{st.user?.name || st.user?.login}</b><span className="subtle small truncate" style={{ display: 'block' }}>{st.repo ? `${st.repo.owner}/${st.repo.repo}` : 'No GitHub repository in this project'}</span></div></div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><Segmented<Tab> value={tab} options={[{ value: 'pulls', label: 'PRs' }, { value: 'issues', label: 'Issues' }, { value: 'runs', label: 'Actions' }, { value: 'repos', label: 'Repos' }]} onChange={setTab} /></div>
    {(tab === 'pulls' || tab === 'issues') && <div className="gh-bar"><select className="select sm" style={{ width: 96 }} value={state} onChange={e => setState(e.target.value as typeof state)}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select><span className="grow" /><Button size="sm" variant="soft" icon={Plus} disabled={!st.repo} onClick={() => void (tab === 'pulls' ? newPull() : newIssue())}>{tab === 'pulls' ? 'New PR' : 'New issue'}</Button></div>}
    <div className="sb-body" style={{ paddingBottom: 16 }}>
      {err && <div className="scm-banner err"><CircleAlert size={14} /><span className="grow selectable">{err}</span></div>}
      {tab !== 'repos' && !st.repo && <EmptyState icon={GithubIcon} title="Not a GitHub project" text="This folder has no GitHub remote. Open a cloned GitHub repository to see its pull requests, issues and workflow runs." />}
      {tab === 'pulls' && st.repo && (pulls.length === 0 && !loading ? <div className="subtle small" style={{ padding: 18 }}>No {state === 'all' ? '' : state} pull requests.</div> : pulls.map(p => <div key={p.number} className="gh-row" onClick={() => useEditor.getState().openPage('github-pr', { number: p.number }, `#${p.number}`)}>
        {p.draft ? <GitPullRequestDraft size={15} className="subtle" /> : <GitPullRequest size={15} className={p.merged ? 'merged-ic' : p.state === 'open' ? 'ok' : 'err'} />}<div className="gh-main"><span className="gh-title truncate">{p.title}</span><span className="gh-sub truncate">#{p.number} · {p.author} · {p.head} → {p.base} · {timeAgo(p.updated)}</span></div>{p.comments > 0 && <span className="subtle tiny row gap4"><MessageSquare size={11} />{p.comments}</span>}</div>))}
      {tab === 'issues' && st.repo && (issues.length === 0 && !loading ? <div className="subtle small" style={{ padding: 18 }}>No {state === 'all' ? '' : state} issues.</div> : issues.map(i => <div key={i.number} className="gh-row" onClick={() => void openIssue(i)}>
        <CircleDot size={15} className={i.state === 'open' ? 'ok' : 'merged-ic'} /><div className="gh-main"><span className="gh-title truncate">{i.title}</span><span className="gh-sub truncate">#{i.number} · {i.author} · {timeAgo(i.updated)}</span>{i.labels.length > 0 && <span className="row gap4" style={{ marginTop: 2, flexWrap: 'wrap' }}>{i.labels.slice(0, 3).map(l => <span key={l.name} className="gh-label" style={{ background: `#${l.color}33`, color: `#${l.color}`, boxShadow: `inset 0 0 0 1px #${l.color}66` }}>{l.name}</span>)}</span>}</div>{i.comments > 0 && <span className="subtle tiny row gap4"><MessageSquare size={11} />{i.comments}</span>}</div>))}
      {tab === 'runs' && st.repo && (runs.length === 0 && !loading ? <div className="subtle small" style={{ padding: 18 }}>No workflow runs.</div> : runs.map(r => <div key={r.id} className="gh-row" onClick={() => void api.fs.openExternal(r.url)}>{runIcon(r)}<div className="gh-main"><span className="gh-title truncate">{r.name}</span><span className="gh-sub truncate">{r.branch} · {r.event} · {timeAgo(r.created)} · <span className="mono">{r.sha.slice(0, 7)}</span></span></div><Play size={11} className="subtle" /></div>))}
      {tab === 'repos' && repos.map(r => <div key={r.full} className="gh-row" style={{ cursor: 'default' }}>{r.private ? <Lock size={14} className="subtle" /> : <GithubIcon size={14} />}<div className="gh-main"><span className="gh-title truncate">{r.full}</span><span className="gh-sub truncate">{r.description || 'No description'} · ★ {r.stars}</span></div>
        <IconButton icon={Download} size="sm" tip="Clone…" onClick={async () => { const dir = await api.fs.pickFolder('Choose where to clone'); if (!dir) return; try { const p = await api.git.clone(r.cloneUrl, dir); toast.success('Cloned.'); void openWorkspace(p) } catch (e) { toast.error((e as Error).message) } }} /></div>)}
      {loading && <div className="center" style={{ padding: 14 }}><Spinner /></div>}
    </div>
  </>
}
