import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, Cloud, FolderGit2, GitBranch, GitMerge, Minus, Plus, RefreshCw, Sparkles, Tag, Trash2, Undo2, CircleAlert, FileText, Eye, X, GitFork, Loader2 } from 'lucide-react'
import type { GitBranch as Branch, GitCommit, GitFile, GitStash } from '@shared/dev'
import { api } from '../../lib/api'
import { basename, cn, copyText, dirname, joinPath, timeAgo } from '../../lib/util'
import { Button, Collapsible, EmptyState, IconButton, Menu, MenuButton, useContextMenu } from '../../components/ui'
import { FileIcon } from '../../lib/icons'
import { useGit } from '../../stores/git'
import { useEditor } from '../../stores/editor'
import { useAi } from '../../stores/ai'
import { useUi, dialogs, toast, type MenuEntry } from '../../stores/ui'
import { runCommand } from '../../lib/commands'
import { pick } from '../shell/Palette'

const LETTER_COLOR: Record<string, string> = { M: 'var(--info)', A: 'var(--success)', U: 'var(--success)', D: 'var(--danger)', R: 'var(--info)', C: 'var(--danger)' }
const statusLetter = (f: GitFile, staged: boolean) => (f.conflict ? 'C' : f.untracked ? 'U' : staged ? f.index : f.worktree)

async function guarded<T>(label: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try { const r = await useGit.getState().run(label, fn); if (ok) toast.success(ok); return r } catch (e) { toast.error((e as Error).message.replace(/^Error invoking.*?: /, '')); return undefined }
}

// ───────────── commit box ─────────────
function CommitBox() {
  const git = useGit(s => s.status)!
  const busy = useGit(s => s.busy)
  const [msg, setMsg] = useState('')
  const [gen, setGen] = useState(false)
  const [amend, setAmend] = useState(false)
  const staged = git.files.filter(f => f.staged).length
  const changed = git.files.filter(f => f.unstaged || f.untracked).length
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const t = ta.current; if (t) { t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px' } }, [msg])
  const commit = async (o: { push?: boolean; stageAll?: boolean } = {}) => {
    if (!msg.trim() && !amend) { toast.warn('Write a commit message first.'); ta.current?.focus(); return }
    if (!staged && !o.stageAll && !amend) {
      if (!changed) { toast.info('Nothing to commit.'); return }
      if (!(await dialogs.confirm({ title: 'Nothing is staged', message: 'Commit all your changes instead?', confirmLabel: 'Commit all' }))) return
      o.stageAll = true
    }
    const hash = await guarded('commit', () => api.git.commit({ message: msg.trim(), amend, stageAll: o.stageAll }), undefined)
    if (hash === undefined) return
    setMsg(''); setAmend(false); toast.success('Committed.')
    if (o.push) await guarded('push', () => api.git.push({ setUpstream: !git.upstream }), 'Pushed.')
  }
  const generate = async () => {
    setGen(true)
    try {
      let diff = await api.git.diffText('staged'); let scope = 'staged'
      if (!diff.trim()) { diff = await api.git.diffText('all'); scope = 'all' }
      if (!diff.trim()) { toast.info('No changes to describe.'); return }
      const recent = (await api.git.log({ limit: 8 }).catch(() => [])).map(c => c.subject).join('\n')
      const text = await api.ai.complete('You write git commit messages. Reply with only the message: a concise imperative subject line (max 72 chars), optionally followed by a blank line and a short body of bullet points for non-trivial changes. Match the style of the recent commits. No quotes, no markdown fences.', `Recent commit subjects:\n${recent || '(none)'}\n\nChanges (${scope}):\n${diff.slice(0, 24000)}`, { maxTokens: 300 })
      setMsg(text.trim().replace(/^```\w*\n?|```$/g, '').trim())
    } catch (e) { toast.error((e as Error).message) } finally { setGen(false) }
  }
  return <div className="commit-box">
    <div className="cb-wrap">
      <textarea ref={ta} className="cm-input" rows={1} value={msg} placeholder={amend ? 'Amend: leave empty to keep the previous message' : `Message (Ctrl+Enter to commit on “${git.branch ?? 'HEAD'}”)`} onChange={e => setMsg(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit() } }} aria-label="Commit message" />
      <button className="cm-ai" onClick={() => void generate()} disabled={gen} data-tip="Write the message with AI">{gen ? <Loader2 size={14} className="spin-anim" /> : <Sparkles size={14} />}</button>
    </div>
    <div className="row gap6">
      <Button variant="primary" style={{ flex: 1 }} disabled={!!busy} icon={Check} onClick={() => void commit()}>{amend ? 'Amend commit' : 'Commit'}{staged > 0 && <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: 'inherit', marginLeft: 4 }}>{staged}</span>}</Button>
      <MenuButton variant="secondary" icon={ChevronDown} tip="More commit options" placement="bottom-end" items={() => [
        { label: 'Commit & push', icon: ArrowUp, onClick: () => void commit({ push: true }) },
        { label: 'Commit all changes', icon: Check, onClick: () => void commit({ stageAll: true }) },
        { separator: true },
        { label: 'Amend previous commit', checked: amend, onClick: () => setAmend(!amend) }
      ]} />
    </div>
  </div>
}

// ───────────── file rows ─────────────
function FileRow({ f, staged, root }: { f: GitFile; staged: boolean; root: string }) {
  const ctx = useContextMenu()
  const abs = joinPath(root, f.path)
  const letter = statusLetter(f, staged)
  const rel = f.path
  const open = () => {
    if (f.conflict) { void useEditor.getState().openFile(abs, { pin: true }); return }
    if (f.untracked || letter === 'D' && !staged) { if (letter !== 'D') { void useEditor.getState().openFile(abs, { pin: true }); return } }
    useEditor.getState().openDiff({ mode: staged ? 'staged' : 'unstaged', path: abs, status: letter })
  }
  const stage = () => void guarded('stage', () => api.git.stage([rel]))
  const unstage = () => void guarded('unstage', () => api.git.unstage([rel]))
  const discard = async () => { if (await dialogs.confirm({ title: f.untracked ? `Delete ${basename(rel)}?` : `Discard changes to ${basename(rel)}?`, message: f.untracked ? 'This untracked file is deleted from disk.' : 'This permanently reverts the file to its last committed state.', confirmLabel: f.untracked ? 'Delete' : 'Discard', danger: true })) await guarded('discard', () => api.git.discard([rel])) }
  const menu = (): MenuEntry[] => [
    { label: 'Open changes', icon: Eye, onClick: open }, { label: 'Open file', icon: FileText, onClick: () => void useEditor.getState().openFile(abs, { pin: true }) }, { separator: true },
    staged ? { label: 'Unstage', icon: Minus, onClick: unstage } : { label: 'Stage', icon: Plus, onClick: stage },
    ...(!staged ? [{ label: f.untracked ? 'Delete file' : 'Discard changes', icon: Undo2, danger: true, onClick: () => void discard() }] : []), { separator: true },
    { label: 'Add to .gitignore', onClick: () => void guarded('ignore', () => api.git.ignore(rel), 'Added to .gitignore') },
    { label: 'Add to AI context', icon: Sparkles, onClick: async () => { await useAi.getState().addContext(await api.ai.context.describe(abs)); useUi.getState().set({ aiVisible: true }) } },
    { label: 'Copy path', onClick: () => void copyText(abs) }, { label: 'Reveal in file explorer', onClick: () => void api.fs.reveal(abs) }
  ]
  return <div className="scm-row" onClick={open} onContextMenu={e => ctx(e, menu())} data-tip={rel}>
    <FileIcon name={basename(rel)} size={15} /><span className={cn('scm-name truncate', letter === 'D' && 'deleted')}>{basename(rel)}</span><span className="scm-dir truncate">{dirname(rel)}</span>
    <span className="scm-acts">
      <IconButton icon={FileText} size="sm" tip="Open file" onClick={e => { e.stopPropagation(); void useEditor.getState().openFile(abs, { pin: true }) }} />
      {!staged && <IconButton icon={Undo2} size="sm" tip={f.untracked ? 'Delete file' : 'Discard changes'} onClick={e => { e.stopPropagation(); void discard() }} />}
      {staged ? <IconButton icon={Minus} size="sm" tip="Unstage" onClick={e => { e.stopPropagation(); unstage() }} /> : <IconButton icon={Plus} size="sm" tip="Stage" onClick={e => { e.stopPropagation(); stage() }} />}
    </span>
    <span className="scm-letter" style={{ color: LETTER_COLOR[letter] ?? 'var(--fg-muted)' }}>{letter}</span>
  </div>
}

function ConflictRow({ f, root }: { f: GitFile; root: string }) {
  const abs = joinPath(root, f.path)
  const resolve = async (r: 'ours' | 'theirs' | 'both') => { await guarded('resolve', async () => { await api.git.resolveConflict(f.path, r); await api.git.stage([f.path]) }, `Resolved ${basename(f.path)}`) }
  return <div className="scm-conflict">
    <div className="scm-row" style={{ margin: 0 }} onClick={() => void useEditor.getState().openFile(abs, { pin: true })}><FileIcon name={basename(f.path)} size={15} /><span className="scm-name truncate">{basename(f.path)}</span><span className="scm-dir truncate">{dirname(f.path)}</span><span className="scm-letter" style={{ color: 'var(--danger)' }}>C</span></div>
    <div className="row gap4" style={{ padding: '0 8px 6px 30px', flexWrap: 'wrap' }}><Button size="sm" variant="secondary" onClick={() => void resolve('ours')} tip="Keep your version (current branch)">Keep mine</Button><Button size="sm" variant="secondary" onClick={() => void resolve('theirs')} tip="Take the incoming version">Take theirs</Button><Button size="sm" variant="secondary" onClick={() => void resolve('both')}>Keep both</Button>
      <Button size="sm" variant="ghost" icon={Check} tip="I fixed the markers by hand" onClick={() => void guarded('stage', () => api.git.stage([f.path]))}>Mark resolved</Button></div>
  </div>
}

// ───────────── branches / history / stashes ─────────────
export async function branchPicker(): Promise<void> {
  const branches = await api.git.branches()
  const local = branches.filter(b => !b.remote), remote = branches.filter(b => b.remote && !local.some(l => b.name.endsWith('/' + l.name)))
  const v = await pick<{ kind: 'new' } | { kind: 'co'; b: Branch }>({ title: 'Switch branch', placeholder: 'Select a branch or create a new one', items: [
    { label: 'Create new branch…', value: { kind: 'new' }, icon: <Plus size={15} /> },
    ...local.map(b => ({ label: b.name, description: b.current ? 'current' : b.upstream ? `↳ ${b.upstream}` : '', detail: b.subject, value: { kind: 'co' as const, b }, separator: b === local[0] ? 'Local branches' : undefined })),
    ...remote.map(b => ({ label: b.name, description: 'remote', detail: b.subject, value: { kind: 'co' as const, b }, separator: b === remote[0] ? 'Remote branches' : undefined }))] })
  if (!v) return
  if (v.kind === 'new') { await newBranch(); return }
  if (v.b.current) return
  await guarded('checkout', () => api.git.checkout(v.b.remote ? v.b.name.replace(/^[^/]+\//, '') : v.b.name), `Switched to ${v.b.name}`)
}
async function newBranch(from?: string) {
  const name = await dialogs.prompt({ title: 'New branch', message: from ? `Create a branch from ${from}.` : 'Created from the current commit and checked out.', placeholder: 'feature/my-change', confirmLabel: 'Create branch', validate: v => (/^[\w./-]+$/.test(v.trim()) ? null : 'Use letters, numbers, - _ . / only') })
  if (name) await guarded('branch', () => api.git.checkout(name.trim(), true, from), `Created ${name.trim()}`)
}

function BranchesSection() {
  const git = useGit(s => s.status)!
  const [list, setList] = useState<Branch[]>([])
  const ctx = useContextMenu()
  const load = useCallback(() => void api.git.branches().then(setList).catch(() => undefined), [])
  useEffect(load, [load, git.branch, git.head])
  const local = list.filter(b => !b.remote)
  return <Collapsible title="Branches" count={local.length} storageKey="scm-branches" defaultOpen={false} actions={<IconButton icon={Plus} size="sm" tip="New branch" onClick={() => void newBranch()} />}>
    {local.map(b => <div key={b.name} className={cn('scm-row', b.current && 'cur')} onClick={() => !b.current && void guarded('checkout', () => api.git.checkout(b.name), `Switched to ${b.name}`)}
      onContextMenu={e => ctx(e, [
        { label: 'Checkout', disabled: b.current, onClick: () => void guarded('checkout', () => api.git.checkout(b.name)) },
        { label: `Merge into ${git.branch ?? 'current'}`, icon: GitMerge, disabled: b.current, onClick: async () => { const r = await guarded('merge', () => api.git.merge(b.name)); if (r !== undefined) toast.info(r || 'Merged.') } },
        { label: `Rebase ${git.branch ?? 'current'} onto this`, disabled: b.current, onClick: async () => { if (await dialogs.confirm({ title: `Rebase onto ${b.name}?`, message: 'Rewrites the commits of the current branch.', confirmLabel: 'Rebase' })) { const r = await guarded('rebase', () => api.git.rebase(b.name)); if (r !== undefined) toast.info(r || 'Rebased.') } } },
        { label: 'New branch from here…', onClick: () => void newBranch(b.name) },
        { label: 'Rename…', onClick: async () => { const n = await dialogs.prompt({ title: 'Rename branch', initial: b.name }); if (n && n !== b.name) await guarded('rename', () => api.git.renameBranch(b.name, n.trim())) } },
        { separator: true },
        { label: 'Delete branch', icon: Trash2, danger: true, disabled: b.current, onClick: async () => { if (await dialogs.confirm({ title: `Delete ${b.name}?`, message: 'Unmerged commits on this branch may be lost.', confirmLabel: 'Delete', danger: true })) await guarded('delete', () => api.git.deleteBranch(b.name, true)) } }])}>
      <GitBranch size={14} className={b.current ? 'accent-ic' : 'subtle'} /><span className="scm-name truncate">{b.name}</span><span className="scm-dir truncate">{b.subject}</span>{b.current && <Check size={13} className="accent-ic" />}{(b.ahead || b.behind) ? <span className="subtle tiny">{b.behind}↓ {b.ahead}↑</span> : null}</div>)}
  </Collapsible>
}

function HistorySection() {
  const git = useGit(s => s.status)!
  const [log, setLog] = useState<GitCommit[]>([])
  const [more, setMore] = useState(true)
  const ctx = useContextMenu()
  const load = useCallback(async (reset: boolean) => { const skip = reset ? 0 : log.length; const r = await api.git.log({ limit: 30, skip }).catch(() => []); setLog(reset ? r : [...log, ...r]); setMore(r.length === 30) }, [log])
  useEffect(() => { void load(true) }, [git.head, git.branch]) // eslint-disable-line react-hooks/exhaustive-deps
  const menu = (c: GitCommit): MenuEntry[] => [
    { label: 'Show commit', icon: Eye, onClick: () => useEditor.getState().openPage('commit', { hash: c.hash }, c.short) },
    { label: 'Copy hash', onClick: () => void copyText(c.hash) }, { separator: true },
    { label: 'Checkout (detached)', onClick: () => void guarded('checkout', () => api.git.checkout(c.hash)) },
    { label: 'New branch from here…', onClick: () => void newBranch(c.hash) },
    { label: 'Create tag…', icon: Tag, onClick: async () => { const t = await dialogs.prompt({ title: 'Create tag', placeholder: 'v1.0.0' }); if (t) await guarded('tag', () => api.git.createTag(t.trim()), `Tagged ${t.trim()}`) } },
    { separator: true },
    { label: 'Cherry-pick', onClick: async () => { const r = await guarded('cherry-pick', () => api.git.cherryPick(c.hash)); if (r !== undefined) toast.success('Cherry-picked.') } },
    { label: 'Revert commit', onClick: async () => { if (await dialogs.confirm({ title: `Revert ${c.short}?`, message: 'Creates a new commit that undoes it.', confirmLabel: 'Revert' })) { const r = await guarded('revert', () => api.git.revert(c.hash)); if (r !== undefined) toast.success('Reverted.') } } }]
  return <Collapsible title="History" storageKey="scm-history" defaultOpen={false} actions={<IconButton icon={RefreshCw} size="sm" tip="Refresh" onClick={() => void load(true)} />}>
    {log.map(c => <div key={c.hash} className="hist-row" onClick={() => useEditor.getState().openPage('commit', { hash: c.hash }, c.short)} onContextMenu={e => ctx(e, menu(c))}>
      <span className="hist-dot" /><div className="hist-main"><span className="hist-subj truncate">{c.subject}</span><span className="hist-meta truncate">{c.author} · {timeAgo(c.date)} · <span className="mono">{c.short}</span></span></div>
      {c.refs.slice(0, 2).map(r => <span key={r} className={cn('badge', r.includes('HEAD') ? 'accent' : r.startsWith('tag') ? 'warning' : 'info')}>{r.replace('HEAD -> ', '').replace('tag: ', '')}</span>)}</div>)}
    {log.length === 0 && <div className="subtle small" style={{ padding: '6px 18px' }}>No commits yet.</div>}
    {more && log.length > 0 && <button className="link-btn small" style={{ padding: '6px 18px' }} onClick={() => void load(false)}>Load more</button>}
  </Collapsible>
}

function StashSection() {
  const git = useGit(s => s.status)!
  const [list, setList] = useState<GitStash[]>([])
  useEffect(() => { void api.git.stashList().then(setList).catch(() => undefined) }, [git.stashCount, git.head])
  if (!list.length) return null
  return <Collapsible title="Stashes" count={list.length} storageKey="scm-stash" defaultOpen={false}>
    {list.map(s => <div key={s.index} className="scm-row" style={{ cursor: 'default' }}>
      <Archive size={14} className="subtle" /><span className="scm-name truncate">{s.message || `stash@{${s.index}}`}</span><span className="scm-dir truncate">{s.branch} · {timeAgo(s.date)}</span>
      <span className="scm-acts"><IconButton icon={Eye} size="sm" tip="Show changes" onClick={async () => dialogs.custom({ title: s.message || `stash@{${s.index}}`, wide: true, render: () => <StashDiff index={s.index} /> })} /><IconButton icon={Undo2} size="sm" tip="Apply and drop (pop)" onClick={() => void guarded('stash', () => api.git.stashApply(s.index, true), 'Stash applied')} /><IconButton icon={Trash2} size="sm" tip="Drop stash" onClick={() => void guarded('stash', () => api.git.stashDrop(s.index))} /></span></div>)}
  </Collapsible>
}
function StashDiff({ index }: { index: number }) {
  const [t, setT] = useState('Loading…')
  useEffect(() => { void api.git.stashShow(index).then(setT).catch(e => setT((e as Error).message)) }, [index])
  return <pre className="t-pre selectable" style={{ maxHeight: '60vh', color: 'var(--fg)' }}>{t}</pre>
}

// ───────────── view ─────────────
export function ScmView() {
  const git = useGit(s => s.status)
  const busy = useGit(s => s.busy)
  const err = useGit(s => s.lastError)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  useEffect(() => { void useGit.getState().refresh() }, [])
  const groups = useMemo(() => {
    const files = git?.files ?? []
    return { conflicts: files.filter(f => f.conflict), staged: files.filter(f => f.staged && !f.conflict), changes: files.filter(f => (f.unstaged || f.untracked) && !f.conflict) }
  }, [git])
  if (!git || !git.isRepo) return <>
    <div className="sb-head"><h2>Source Control</h2></div>
    {git?.gitMissing ? <EmptyState icon={CircleAlert} title="Git isn’t installed" text="Install Git for Windows (git-scm.com) and restart the app to use source control." />
      : <EmptyState icon={FolderGit2} title="Not a Git repository" text="Track changes, commit and collaborate by turning this folder into a Git repository.">
        <div className="col gap8" style={{ width: '100%', maxWidth: 220, marginTop: 8 }}><Button variant="primary" icon={GitBranch} onClick={() => void runCommand('git.init')}>Initialize repository</Button><Button icon={Cloud} onClick={() => void runCommand('git.clone')}>Clone a repository</Button></div></EmptyState>}
  </>
  const root = git.root
  return <>
    <div className="sb-head"><h2>Source Control</h2>
      <IconButton icon={RefreshCw} size="sm" tip="Refresh" onClick={() => void useGit.getState().refresh()} />
      <IconButton icon={Archive} size="sm" tip="Stash changes" onClick={() => void runCommand('git.stash')} />
      <IconButton icon={ArrowDown} size="sm" tip="Pull" onClick={() => void runCommand('git.pull')} /><IconButton icon={ArrowUp} size="sm" tip="Push" onClick={() => void runCommand('git.push')} />
      <IconButton icon={GitFork} size="sm" tip="More actions" onClick={e => setMenu(menu ? null : e.currentTarget)} />
      {menu && <Menu anchor={menu} placement="bottom-end" onClose={() => setMenu(null)} items={[{ label: 'Fetch', onClick: () => void runCommand('git.fetch') }, { label: 'Pull', onClick: () => void runCommand('git.pull') }, { label: 'Push', onClick: () => void runCommand('git.push') }, { label: 'Sync (pull & push)', onClick: () => void runCommand('git.sync') }, { separator: true }, { label: 'Stage all', onClick: () => void runCommand('git.stageAll') }, { label: 'Unstage all', onClick: () => void guarded('unstage', () => api.git.unstageAll()) }, { separator: true }, { label: 'Create tag…', icon: Tag, onClick: async () => { const t = await dialogs.prompt({ title: 'Create tag', placeholder: 'v1.0.0' }); if (t) await guarded('tag', () => api.git.createTag(t.trim()), 'Tag created') } }, { label: 'Git identity…', onClick: async () => { const id = await api.git.identity(); const n = await dialogs.prompt({ title: 'Your name for commits', initial: id.name }); if (n === null) return; const em = await dialogs.prompt({ title: 'Your email for commits', initial: id.email }); if (em !== null) await api.git.setIdentity(n.trim(), em.trim()) } }]} />}
    </div>
    <div className="scm-branchbar"><button className="chip clickable" onClick={() => void branchPicker()}><GitBranch size={13} /><b>{git.branch ?? `(${git.head ?? 'detached'})`}</b><ChevronDown size={12} /></button>
      {(git.ahead > 0 || git.behind > 0) && <span className="subtle small">{git.behind}↓ {git.ahead}↑</span>}{!git.upstream && git.branch && <span className="subtle small">not published</span>}<span className="grow" />
      <Button size="sm" variant="ghost" icon={busy ? Loader2 : RefreshCw} disabled={!!busy} onClick={() => void runCommand('git.sync')}>{busy ? 'Working…' : 'Sync'}</Button></div>
    {(git.merging || git.rebasing || git.cherryPicking) && <div className="scm-banner"><GitMerge size={14} /><span className="grow">{git.merging ? 'Merge in progress' : git.rebasing ? 'Rebase in progress' : 'Cherry-pick in progress'}{groups.conflicts.length ? ` — ${groups.conflicts.length} conflict${groups.conflicts.length > 1 ? 's' : ''} to resolve` : ' — ready to continue'}</span>
      {git.merging && <Button size="sm" variant="secondary" onClick={() => void guarded('merge', () => api.git.mergeAbort(), 'Merge aborted')}>Abort</Button>}
      {git.rebasing && <><Button size="sm" variant="secondary" disabled={groups.conflicts.length > 0} onClick={() => void guarded('rebase', () => api.git.rebaseAction('continue'))}>Continue</Button><Button size="sm" variant="ghost" onClick={() => void guarded('rebase', () => api.git.rebaseAction('abort'))}>Abort</Button></>}</div>}
    {err && <div className="scm-banner err"><CircleAlert size={14} /><span className="grow selectable">{err}</span><IconButton icon={X} size="sm" onClick={() => useGit.setState({ lastError: null })} tip="Dismiss" /></div>}
    <div className="sb-body" style={{ paddingBottom: 20 }}>
      <CommitBox />
      {groups.conflicts.length > 0 && <Collapsible title="Merge conflicts" count={groups.conflicts.length} storageKey="scm-conf">{groups.conflicts.map(f => <ConflictRow key={f.path} f={f} root={root} />)}</Collapsible>}
      <Collapsible title="Staged changes" count={groups.staged.length} storageKey="scm-staged" actions={groups.staged.length > 0 ? <IconButton icon={Minus} size="sm" tip="Unstage all" onClick={() => void guarded('unstage', () => api.git.unstageAll())} /> : undefined}>
        {groups.staged.length === 0 ? <div className="subtle small" style={{ padding: '4px 18px 8px' }}>Stage files with + to include them in the next commit.</div> : groups.staged.map(f => <FileRow key={'s' + f.path} f={f} staged root={root} />)}</Collapsible>
      <Collapsible title="Changes" count={groups.changes.length} storageKey="scm-changes" actions={groups.changes.length > 0 ? <><IconButton icon={Undo2} size="sm" tip="Discard all changes" onClick={async () => { if (await dialogs.confirm({ title: 'Discard ALL changes?', message: `${groups.changes.length} file(s) are reverted or deleted. This cannot be undone.`, confirmLabel: 'Discard all', danger: true })) await guarded('discard', () => api.git.discard(groups.changes.map(f => f.path))) }} /><IconButton icon={Plus} size="sm" tip="Stage all" onClick={() => void guarded('stage', () => api.git.stageAll())} /></> : undefined}>
        {groups.changes.length === 0 ? <div className="subtle small" style={{ padding: '4px 18px 8px' }}>{groups.staged.length ? 'No other changes.' : 'Working tree is clean. 🎉'}</div> : groups.changes.map(f => <FileRow key={'c' + f.path} f={f} staged={false} root={root} />)}</Collapsible>
      <BranchesSection /><HistorySection /><StashSection />
    </div>
  </>
}

