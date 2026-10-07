import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Download, FileText, FolderGit2, FolderOpen, GitBranch, History, Image as ImageIcon, KeyRound, Palette, Plus, Puzzle, Sparkles, ChevronDown, Flame, MessageSquare } from 'lucide-react'
import type { UsageStats } from '@shared/ai'
import { api } from '../../lib/api'
import { basename, cn, formatTokens, timeAgo } from '../../lib/util'
import { Button, Popover } from '../../components/ui'
import { Mascot } from '../../components/brand'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { runCommand } from '../../lib/commands'
import { Composer } from '../ai/Composer'
import { ContextBar } from '../ai/ContextBar'
import { Markdown } from '../ai/Markdown'
import { useChatModels } from '../ai/Selectors'
import { allDocs, useDocs } from '../../lib/docs'
import { openWorkspace } from '../../commands'

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Burning the midnight oil?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ───────────── activity heatmap (last 26 weeks) ─────────────
function Heatmap({ daily }: { daily: UsageStats['daily'] }) {
  const cells = useMemo(() => {
    const map = new Map(daily.map(d => [d.date, d.count]))
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const start = new Date(today); start.setDate(start.getDate() - (26 * 7 - 1) - today.getDay())
    const out: { date: string; count: number; future: boolean }[] = []
    for (let d = new Date(start); d <= today || d.getDay() !== 0; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      out.push({ date: key, count: map.get(key) ?? 0, future: d > today })
      if (out.length > 26 * 7 + 7) break
    }
    return out
  }, [daily])
  const max = Math.max(1, ...cells.map(c => c.count))
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.99)))
  const weeks = Math.ceil(cells.length / 7)
  return <div className="heatmap" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} role="img" aria-label="Activity over the last six months">
    {cells.map(c => <i key={c.date} className={cn('hm', `l${level(c.count)}`, c.future && 'future')} data-tip={c.future ? undefined : `${c.count} message${c.count === 1 ? '' : 's'} · ${c.date}`} />)}
  </div>
}

function Stat({ icon: Icon, label, value }: { icon: typeof Flame; label: string; value: string }) {
  return <div className="stat"><div className="stat-ic"><Icon size={15} /></div><div><div className="stat-val">{value}</div><div className="stat-label">{label}</div></div></div>
}

function StatsCard() {
  const [stats, setStats] = useState<UsageStats | null>(null)
  useEffect(() => { void api.ai.sessions.stats().then(setStats).catch(() => undefined) }, [])
  if (!stats || stats.messages === 0) return null
  return <section className="card home-card">
    <div className="hc-head"><h3>Your activity</h3><span className="subtle small">Last 6 months</span></div>
    <div className="stat-grid">
      <Stat icon={MessageSquare} label="Chats" value={String(stats.sessions)} />
      <Stat icon={Sparkles} label="Messages" value={stats.messages.toLocaleString()} />
      <Stat icon={Flame} label="Active days" value={String(stats.activeDays)} />
      <Stat icon={BookOpen} label="Tokens" value={formatTokens(stats.tokens)} />
    </div>
    <Heatmap daily={stats.daily} />
    <div className="hm-legend"><span>{stats.favoriteModel ? <>Favourite model <b>{stats.favoriteModel}</b></> : ''}{stats.peakHour !== null && <> · Most active around <b>{stats.peakHour}:00</b></>}</span><span className="grow" /><span>Less</span>{[0, 1, 2, 3, 4].map(l => <i key={l} className={cn('hm', `l${l}`)} />)}<span>More</span></div>
  </section>
}

// ───────────── home ─────────────
export function Home() {
  const root = useWorkspace(s => s.root)
  const name = useWorkspace(s => s.name)
  const git = useGit(s => s.status)
  const recent = useSettings(s => s.settings.ui.recentProjects)
  const sessions = useAi(s => s.sessions)
  const active = useAi(s => s.active) // an empty chat that already carries context (files added from the explorer, …)
  const models = useChatModels()
  const [proj, setProj] = useState<HTMLElement | null>(null)
  const quick = [
    { icon: FolderOpen, title: 'Open folder', text: 'Work on a project on this computer', run: () => runCommand('file.openFolder') },
    { icon: FolderGit2, title: 'Clone repository', text: 'Download a Git repository', run: () => runCommand('git.clone') },
    { icon: ImageIcon, title: 'Image studio', text: 'Generate and edit pictures', run: () => runCommand('images.open') },
    { icon: Puzzle, title: 'Extensions & tools', text: 'MCP servers, skills, plugins', run: () => useUi.getState().showView('extensions') },
    { icon: Palette, title: 'Appearance', text: 'Themes, fonts and layout', run: () => useEditor.getState().openPage('settings', { section: 'appearance' }, 'Settings') },
    { icon: KeyRound, title: 'Shortcuts', text: 'See and change key bindings', run: () => runCommand('settings.keybindings') }
  ]
  return <div className="page-scroll"><div className="home">
    <div className="home-hero"><Mascot size={54} /><h1 className="serif">{root ? <>{greeting()}.<br /><span>What shall we build?</span></> : <>Let’s get started.<br /><span>Open a project to begin.</span></>}</h1></div>
    {models.length === 0 && <div className="home-banner"><Sparkles size={16} /><div className="grow"><b>Connect an AI model</b><span> — add a provider and key to chat, edit code with an agent and generate images. Keys never leave this computer.</span></div><Button variant="primary" size="sm" onClick={() => useEditor.getState().openPage('models', undefined, 'Models & providers')}>Connect</Button></div>}
    <div className="hero-compose">
      <ContextBar sessionId={active} />
      <Composer sessionId={active} variant="hero" autoFocus placeholder={root ? 'Describe what you want to build or fix…' : 'Ask anything — or open a project folder for the agent to work in'} />
    </div>
    <div className="home-chips">
      <button className="chip clickable" onClick={e => setProj(proj ? null : e.currentTarget)}><FolderOpen size={13} />{root ? name : 'No folder open'}<ChevronDown size={12} /></button>
      {git?.isRepo && <button className="chip clickable" onClick={() => runCommand('git.checkout')}><GitBranch size={13} />{git.branch ?? 'detached'}</button>}
      {proj && <Popover anchor={proj} placement="bottom-start" width={320} onClose={() => setProj(null)}>
        <div className="menu-title">Recent projects</div>
        {recent.length === 0 && <div className="pal-empty">Nothing here yet.</div>}
        {recent.slice(0, 8).map(p => <button key={p} className="menu-item" onClick={() => { setProj(null); void openWorkspace(p) }}><span className="mi-icon"><FolderOpen size={15} /></span><span className="mi-label truncate">{basename(p)}</span><span className="mi-hint truncate" style={{ maxWidth: 120 }}>{p}</span></button>)}
        <div className="menu-sep" /><button className="menu-item" onClick={() => { setProj(null); void runCommand('file.openFolder') }}><span className="mi-icon"><Plus size={15} /></span><span className="mi-label">Open folder…</span></button>
      </Popover>}
    </div>
    <div className="quick-grid">{quick.map(q => <button key={q.title} className="quick" onClick={q.run}><span className="q-ic"><q.icon size={17} /></span><span className="q-main"><span className="q-title">{q.title}</span><span className="q-text">{q.text}</span></span></button>)}</div>
    <div className="home-two">
      <section className="card home-card"><div className="hc-head"><h3>Recent chats</h3><button className="link-btn small" onClick={() => useUi.getState().showView('ai')}>See all</button></div>
        {sessions.length === 0 ? <div className="subtle small" style={{ padding: '10px 2px' }}>Your conversations will appear here.</div> : sessions.slice(0, 5).map(s => <button key={s.id} className="list-row" onClick={() => void useAi.getState().open(s.id)}><History size={14} className="subtle" /><span className="truncate grow">{s.title}</span><span className="subtle small">{timeAgo(s.updatedAt)}</span></button>)}
      </section>
      <section className="card home-card"><div className="hc-head"><h3>Recent projects</h3><button className="link-btn small" onClick={() => runCommand('file.openFolder')}>Open…</button></div>
        {recent.length === 0 ? <div className="subtle small" style={{ padding: '10px 2px' }}>Projects you open will be listed here.</div> : recent.slice(0, 5).map(p => <button key={p} className="list-row" onClick={() => void openWorkspace(p)} data-tip={p}><FolderOpen size={14} className="subtle" /><span className="truncate grow">{basename(p)}</span></button>)}
      </section>
    </div>
    <StatsCard />
  </div></div>
}

// ───────────── markdown preview (Open Markdown Preview) ─────────────
export function MarkdownPreview({ path }: { path: string }) {
  const [text, setText] = useState('')
  const dirty = useDocs(s => s.dirty[path])
  useEffect(() => {
    let dead = false
    const load = () => { const d = allDocs().find(x => x.path === path); if (d) { setText(d.model.getValue()); return } void api.fs.readFile(path).then(r => { if (!dead && 'content' in r) setText(r.content as string) }) }
    load()
    const d = allDocs().find(x => x.path === path)
    const sub = d?.model.onDidChangeContent(() => load())
    return () => { dead = true; sub?.dispose() }
  }, [path, dirty])
  return <div className="page-scroll"><div className="md-preview"><div className="mp-bar"><FileText size={14} /><span className="truncate">{basename(path)}</span><span className="grow" /><Button size="sm" variant="ghost" icon={Download} onClick={() => void useEditor.getState().openFile(path, { pin: true })}>Edit source</Button></div><Markdown text={text} className="msg-text" /></div></div>
}
