import { useEffect, useState } from 'react'
import { Copy, GitBranchPlus, RotateCcw, Undo2, GitCommitHorizontal, Sparkles } from 'lucide-react'
import type { GitCommitDetail } from '@shared/dev'
import { api } from '../../lib/api'
import { basename, cn, copyText, dirname, joinPath } from '../../lib/util'
import { Button, EmptyState, Spinner } from '../../components/ui'
import { FileIcon } from '../../lib/icons'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useAi } from '../../stores/ai'
import { dialogs, toast, useUi } from '../../stores/ui'

const COLORS: Record<string, string> = { M: 'var(--info)', A: 'var(--success)', D: 'var(--danger)', R: 'var(--info)' }

export function CommitPage({ hash }: { hash: string }) {
  const [c, setC] = useState<GitCommitDetail | null | undefined>(undefined)
  const root = useGit(s => s.status?.root)
  useEffect(() => { setC(undefined); void api.git.show(hash).then(setC).catch(() => setC(null)) }, [hash])
  if (c === undefined) return <div className="center grow"><Spinner size={18} /></div>
  if (c === null) return <div className="page-scroll"><EmptyState icon={GitCommitHorizontal} title="Commit not found" text="It may have been removed by a rebase or an amend." /></div>
  const added = c.files.reduce((n, f) => n + f.added, 0), removed = c.files.reduce((n, f) => n + f.removed, 0)
  const act = async (label: string, fn: () => Promise<string | void>, ok: string) => { try { await useGit.getState().run(label, fn); toast.success(ok) } catch (e) { toast.error((e as Error).message) } }
  const explain = () => { useUi.getState().set({ aiVisible: true }); void useAi.getState().send(`Explain what commit ${c.short} ("${c.subject}") changes and why. Use git show ${c.hash} to read it.`) }
  return <div className="page-scroll"><div className="page narrow">
    <div className="page-head"><div><div className="row gap8 subtle small mono"><GitCommitHorizontal size={14} />{c.hash}<button className="cb-btn" onClick={() => void copyText(c.hash)} data-tip="Copy hash"><Copy size={12} /></button></div>
      <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>{c.subject}</h1></div>
      <div className="row gap8"><Button icon={Sparkles} variant="soft" onClick={explain}>Explain with AI</Button></div></div>
    <div className="card" style={{ padding: '14px 18px' }}>
      <div className="row gap12 small muted" style={{ flexWrap: 'wrap' }}><b style={{ color: 'var(--fg)' }}>{c.author}</b><span>{c.email}</span><span>{new Date(c.date).toLocaleString()}</span>{c.parents.length > 0 && <span>parent <span className="mono">{c.parents.map(p => p.slice(0, 7)).join(', ')}</span></span>}</div>
      {c.refs.length > 0 && <div className="row gap6" style={{ marginTop: 8 }}>{c.refs.map(r => <span key={r} className="badge info">{r}</span>)}</div>}
      {c.body && <pre className="selectable" style={{ margin: '12px 0 0', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-ui)', fontSize: 13.5, lineHeight: 1.6 }}>{c.body}</pre>}
    </div>
    <div className="row gap8">
      <Button icon={GitBranchPlus} onClick={async () => { const n = await dialogs.prompt({ title: 'New branch from this commit', placeholder: 'feature/…' }); if (n) await act('branch', () => api.git.checkout(n.trim(), true, c.hash), `Created ${n.trim()}`) }}>Branch from here</Button>
      <Button icon={RotateCcw} onClick={() => void act('cherry-pick', () => api.git.cherryPick(c.hash), 'Cherry-picked.')}>Cherry-pick</Button>
      <Button icon={Undo2} onClick={async () => { if (await dialogs.confirm({ title: 'Revert this commit?', message: 'Creates a new commit that undoes these changes.', confirmLabel: 'Revert' })) await act('revert', () => api.git.revert(c.hash), 'Reverted.') }}>Revert</Button>
    </div>
    <div className="stat-row"><span className="badge">{c.files.length} file{c.files.length === 1 ? '' : 's'}</span><span className="ok">+{added}</span><span className="err">−{removed}</span></div>
    <div className="card" style={{ overflow: 'hidden' }}>
      {c.files.map(f => <div key={f.path} className="cc-top" onClick={() => root && useEditor.getState().openDiff({ mode: 'commit', path: joinPath(root, f.path), commit: c.hash })}>
        <FileIcon name={basename(f.path)} size={16} /><span className="cc-name truncate">{basename(f.path)}</span><span className="subtle small truncate grow">{dirname(f.path)}{f.oldPath ? ` ← ${f.oldPath}` : ''}</span>
        <span className="ok small">+{f.added}</span><span className="err small">−{f.removed}</span><span className={cn('scm-letter')} style={{ color: COLORS[f.status[0]] ?? 'var(--fg-muted)' }}>{f.status[0]}</span></div>)}
    </div>
  </div></div>
}
