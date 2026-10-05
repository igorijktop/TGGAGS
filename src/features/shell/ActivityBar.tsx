import { Bot, Files, GitBranch, Image, Layers, Puzzle, Search, Settings, Sparkles, Bug, Cpu } from 'lucide-react'
import { GithubIcon as Github } from '../../components/brand'
import type { LucideIcon } from 'lucide-react'
import { useUi, type SidebarView } from '../../stores/ui'
import { useSettings } from '../../stores/settings'
import { useGit } from '../../stores/git'
import { cn } from '../../lib/util'
import { runCommand, formatKeybinding, keybindingFor } from '../../lib/commands'

const ITEMS: { id: SidebarView; label: string; icon: LucideIcon; cmd: string }[] = [
  { id: 'explorer', label: 'Explorer', icon: Files, cmd: 'view.explorer' },
  { id: 'search', label: 'Search', icon: Search, cmd: 'view.search' },
  { id: 'scm', label: 'Git', icon: GitBranch, cmd: 'view.scm' },
  { id: 'run', label: 'Run', icon: Bug, cmd: 'view.run' },
  { id: 'extensions', label: 'Extensions', icon: Puzzle, cmd: 'view.extensions' },
  { id: 'ai', label: 'AI Chats', icon: Sparkles, cmd: 'view.ai' },
  { id: 'agents', label: 'Agents', icon: Bot, cmd: 'view.agents' },
  { id: 'models', label: 'Models', icon: Cpu, cmd: 'view.models' },
  { id: 'images', label: 'Images', icon: Image, cmd: 'view.images' },
  { id: 'github', label: 'GitHub', icon: Github, cmd: 'view.github' }
]

export function ActivityBar() {
  const view = useUi(s => s.sidebarView)
  const visible = useUi(s => s.sidebarVisible)
  const labels = useSettings(s => s.settings.appearance.activityBarLabels)
  const changes = useGit(s => s.status?.files.length ?? 0)
  return (
    <nav className={cn('activity', !labels && 'compact')} aria-label="Activity bar">
      {ITEMS.map(it => {
        const Icon = it.icon
        const kb = keybindingFor(it.cmd)
        return (
          <button key={it.id} className={cn('act-item', view === it.id && visible && 'active')} data-tip={labels ? undefined : it.label} data-kbd={kb ? formatKeybinding(kb) : undefined} data-tip-pos="below" onClick={() => runCommand(it.cmd)} aria-label={it.label}>
            <Icon size={20} strokeWidth={1.7} />
            {labels && <span className="act-label">{it.label}</span>}
            {it.id === 'scm' && changes > 0 && <span className="act-badge">{changes > 99 ? '99+' : changes}</span>}
          </button>
        )
      })}
      <div className="grow" />
      <button className="act-item" data-tip="Settings" data-kbd={formatKeybinding(keybindingFor('settings.open') ?? 'Mod+,')} onClick={() => runCommand('settings.open')} aria-label="Settings"><Settings size={20} strokeWidth={1.7} />{labels && <span className="act-label">Settings</span>}</button>
    </nav>
  )
}
void Layers
