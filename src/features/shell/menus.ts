import { runCommand, keybindingFor, formatKeybinding } from '../../lib/commands'
import type { MenuEntry } from '../../stores/ui'
import { useSettings } from '../../stores/settings'
import { useWorkspace } from '../../stores/workspace'
import { allThemes } from '../../lib/theme'
import { activeMonacoEditor } from '../../lib/editor-context'
import { FilePlus, FolderOpen, Save, Settings, Terminal, Play, Sparkles, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Search, CommandIcon, Bug, SquareTerminal, BookOpen, Info } from './menu-icons'

const hint = (id: string) => { const k = keybindingFor(id); return k ? formatKeybinding(k) : undefined }
const cmd = (label: string, id: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({ label, hint: hint(id), onClick: () => runCommand(id), ...extra })
const monacoAction = (label: string, action: string, h?: string, icon?: MenuEntry['icon']): MenuEntry => ({ label, hint: h, icon, onClick: () => { const ed = activeMonacoEditor(); ed?.focus(); void ed?.getAction(action)?.run() } })
const sep = (): MenuEntry => ({ separator: true })

export function buildMainMenu(): MenuEntry[] {
  const recent = useSettings.getState().settings.ui.recentProjects.slice(0, 8)
  const themes = allThemes()
  const cur = useSettings.getState().settings.appearance.theme
  const hasRoot = !!useWorkspace.getState().root
  return [
    { label: 'File', children: [
      cmd('New File…', 'file.newFile', { icon: FilePlus }), cmd('Open Folder…', 'file.openFolder', { icon: FolderOpen }),
      { label: 'Open Recent', children: recent.length ? recent.map(p => ({ label: p, onClick: () => void useWorkspace.getState().open(p) })) : [{ label: 'No recent folders', disabled: true }] },
      cmd('Clone Repository…', 'git.clone'), sep(),
      cmd('Save', 'file.save', { icon: Save }), cmd('Save All', 'file.saveAll'), sep(),
      cmd('Close Editor', 'file.closeTab'), cmd('Reopen Closed Editor', 'file.reopenClosed'), cmd('Close Folder', 'file.closeFolder', { disabled: !hasRoot }), sep(),
      cmd('Settings', 'settings.open', { icon: Settings }), cmd('Exit', 'app.quit')
    ] },
    { label: 'Edit', children: [
      monacoAction('Undo', 'undo', 'Ctrl+Z', Undo2), monacoAction('Redo', 'redo', 'Ctrl+Y', Redo2), sep(),
      { label: 'Cut', icon: Scissors, hint: 'Ctrl+X', onClick: () => document.execCommand('cut') }, { label: 'Copy', icon: Copy, hint: 'Ctrl+C', onClick: () => document.execCommand('copy') }, { label: 'Paste', icon: ClipboardPaste, hint: 'Ctrl+V', onClick: () => { void navigator.clipboard.readText().then(t => { const ed = activeMonacoEditor(); ed?.trigger('menu', 'type', { text: t }) }) } }, sep(),
      monacoAction('Find', 'actions.find', 'Ctrl+F', Search), monacoAction('Replace', 'editor.action.startFindReplace', 'Ctrl+H'), cmd('Find in Files', 'search.findInFiles'), sep(),
      monacoAction('Toggle Line Comment', 'editor.action.commentLine', 'Ctrl+/'), monacoAction('Format Document', 'editor.action.formatDocument', 'Shift+Alt+F')
    ] },
    { label: 'Selection', children: [
      monacoAction('Select All', 'editor.action.selectAll', 'Ctrl+A'), monacoAction('Expand Selection', 'editor.action.smartSelect.expand', 'Shift+Alt+→'), monacoAction('Shrink Selection', 'editor.action.smartSelect.shrink', 'Shift+Alt+←'), sep(),
      monacoAction('Add Cursor Above', 'editor.action.insertCursorAbove', 'Ctrl+Alt+↑'), monacoAction('Add Cursor Below', 'editor.action.insertCursorBelow', 'Ctrl+Alt+↓'), monacoAction('Add Next Occurrence', 'editor.action.addSelectionToNextFindMatch', 'Ctrl+D'), monacoAction('Select All Occurrences', 'editor.action.selectHighlights', 'Ctrl+Shift+L')
    ] },
    { label: 'View', children: [
      cmd('Command Palette…', 'palette.commands', { icon: CommandIcon }), sep(),
      cmd('Explorer', 'view.explorer'), cmd('Search', 'view.search'), cmd('Source Control', 'view.scm'), cmd('Run and Debug', 'view.run'), cmd('Extensions', 'view.extensions'), sep(),
      cmd('Toggle Sidebar', 'view.toggleSidebar'), cmd('Toggle Bottom Panel', 'view.togglePanel'), cmd('Toggle AI Chat', 'view.toggleAi'), cmd('Maximize AI Chat', 'view.chatFocus'), cmd('Zen Mode', 'view.zen'), sep(),
      { label: 'Color Theme', children: themes.map(t => ({ label: t.name, checked: t.id === cur, onClick: () => void useSettings.getState().update({ appearance: { theme: t.id } }) })) },
      cmd('Zoom In', 'view.zoomIn'), cmd('Zoom Out', 'view.zoomOut'), cmd('Reset Zoom', 'view.zoomReset'), cmd('Full Screen', 'view.fullscreen')
    ] },
    { label: 'Go', children: [cmd('Back', 'nav.back'), cmd('Forward', 'nav.forward'), sep(), cmd('Go to File…', 'palette.files'), cmd('Go to Symbol in File…', 'palette.symbols'), cmd('Go to Symbol in Project…', 'palette.workspaceSymbols'), cmd('Go to Line…', 'palette.goToLine')] },
    { label: 'Run', children: [cmd('Start Debugging', 'debug.start', { icon: Bug }), cmd('Run Without Debugging', 'debug.run', { icon: Play }), cmd('Stop', 'debug.stop'), cmd('Restart', 'debug.restart'), sep(), cmd('Toggle Breakpoint', 'debug.toggleBreakpoint'), cmd('Step Over', 'debug.stepOver'), cmd('Step Into', 'debug.stepInto'), cmd('Step Out', 'debug.stepOut'), cmd('Continue', 'debug.continue')] },
    { label: 'Terminal', children: [cmd('New Terminal', 'terminal.new', { icon: Terminal }), cmd('Toggle Terminal', 'terminal.toggle', { icon: SquareTerminal }), cmd('Kill Terminal', 'terminal.kill')] },
    { label: 'AI', children: [cmd('New Chat', 'ai.newChat', { icon: Sparkles }), cmd('Focus Chat', 'ai.focus'), cmd('Stop Generating', 'ai.stop'), sep(), cmd('Compact Conversation', 'ai.compact'), cmd('Undo Last AI Changes', 'ai.undo'), cmd('Redo AI Changes', 'ai.redo'), sep(), cmd('Cycle Permission Mode', 'ai.cycleMode'), cmd('Add Selection to Chat', 'ai.addSelection'), cmd('Explain Selection', 'ai.explain'), cmd('Fix Problems in File', 'ai.fix'), sep(), cmd('Manage Models…', 'settings.models'), cmd('Manage Agents…', 'view.agents')] },
    { label: 'Help', children: [cmd('Keyboard Shortcuts', 'settings.keybindings'), cmd('Welcome', 'home.open', { icon: BookOpen }), sep(), cmd('Check for Updates…', 'help.checkUpdates'), sep(), cmd('Open Logs Folder', 'help.logs'), cmd('Open Data Folder', 'help.userData'), cmd('Toggle Developer Tools', 'view.devtools'), sep(), cmd('About', 'help.about', { icon: Info })] }
  ]
}
