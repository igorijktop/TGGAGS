import { ArrowLeft, ArrowRight, Menu as MenuIcon, Minus, PanelBottom, PanelLeft, PanelRight, Search, Settings, Square, X, Copy, Bell } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, isMac, isWin, onEvent, platform } from '../../lib/api'
import { formatKeybinding, keybindingFor, runCommand } from '../../lib/commands'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { IconButton, Menu } from '../../components/ui'
import { buildMainMenu } from './menus'
import { UpdateButton } from './UpdateButton'
import { Badge } from '../../components/ui'

export function TopBar() {
  const ui = useUi()
  const ws = useWorkspace()
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null)
  const [maximized, setMaximized] = useState(false)
  const kb = (id: string) => { const k = keybindingFor(id); return k ? formatKeybinding(k) : undefined }
  useEffect(() => { void api.window.isMaximized().then(setMaximized); return onEvent('window:maximized', setMaximized) }, [])
  const custom = !isWin && !isMac
  return (
    <div className={`topbar${isWin ? ' win-overlay' : ''}`} onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('tb-spacer') || (e.target as HTMLElement).classList.contains('topbar')) void api.window.toggleMaximize() }}>
      <IconButton icon={MenuIcon} tip="Menu" onClick={e => setMenuEl(menuEl ? null : e.currentTarget)} active={!!menuEl} />
      <IconButton icon={PanelLeft} tip="Toggle sidebar" kbd={kb('view.toggleSidebar')} active={ui.sidebarVisible} onClick={() => ui.toggleSidebar()} />
      <IconButton icon={ArrowLeft} tip="Go back" kbd={kb('nav.back')} onClick={() => runCommand('nav.back')} />
      <IconButton icon={ArrowRight} tip="Go forward" kbd={kb('nav.forward')} onClick={() => runCommand('nav.forward')} />
      <div className="command-center" onClick={() => ui.openPalette()} role="button" tabIndex={0}>
        <Search size={13} />
        <span className="cc-name truncate">{ws.root ? ws.name : 'TGGAGS IDE'}</span>
        <span className="muted truncate">{ws.root ? '— search files, commands, symbols' : '— open a folder to begin'}</span>
        <span className="cc-hint kbd">{kb('palette.commands') ?? 'Ctrl+Shift+P'}</span>
      </div>
      <div className="tb-spacer" />
      <UpdateButton />
      <IconButton icon={PanelBottom} tip="Toggle panel" kbd={kb('view.togglePanel')} active={ui.panelVisible} onClick={() => ui.togglePanel()} />
      <IconButton icon={PanelRight} tip="Toggle AI chat" kbd={kb('view.toggleAi')} active={ui.aiVisible} onClick={() => ui.toggleAi()} />
      <IconButton icon={Bell} tip="Notifications" dot={ui.notifications.length > 0 && Date.now() - (ui.notifications[0]?.ts ?? 0) < 60_000} onClick={() => runCommand('view.notifications')} />
      <IconButton icon={Settings} tip="Settings" kbd={kb('settings.open')} onClick={() => runCommand('settings.open')} />
      {custom && <div className="win-controls">
        <button aria-label="Minimize" onClick={() => void api.window.minimize()}><Minus size={15} /></button>
        <button aria-label="Maximize" onClick={() => void api.window.toggleMaximize()}>{maximized ? <Copy size={12} /> : <Square size={12} />}</button>
        <button className="close" aria-label="Close" onClick={() => void api.window.close()}><X size={16} /></button>
      </div>}
      {menuEl && <Menu anchor={menuEl} items={buildMainMenu()} onClose={() => setMenuEl(null)} />}
      {platform === 'never' && <Badge>x</Badge>}
    </div>
  )
}
