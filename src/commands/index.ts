import { registerCommands, type Command, runCommand } from '../lib/commands'
import { api } from '../lib/api'
import { useUi, toast, dialogs, type SidebarView } from '../stores/ui'
import { useEditor } from '../stores/editor'
import { useWorkspace } from '../stores/workspace'
import { useSettings } from '../stores/settings'
import { useAi } from '../stores/ai'
import { useUpdate } from '../stores/update'
import { useGit } from '../stores/git'
import { useDebug } from '../stores/debug'
import { useTerminals } from '../stores/terminal'
import { saveAll, saveDoc, dirtyPaths } from '../lib/docs'
import { activeMonacoEditor, gatherEditorContext } from '../lib/editor-context'
import { allThemes } from '../lib/theme'
import { pick } from '../features/shell/Palette'
import { basename, joinPath, relativeTo, dirname } from '../lib/util'
import type { PermissionMode } from '@shared/settings'
import type { LaunchConfig } from '@shared/dev'
import { createElement } from 'react'
import { Logo } from '../components/brand'
import { focusComposer, revealChat, showChat } from '../lib/chat-nav'

const view = (id: string, v: SidebarView, title: string, kb?: string): Command => ({ id, title, category: 'View', keybinding: kb, run: () => useUi.getState().showView(v) })

async function openFolder() {
  const dir = await api.fs.pickFolder('Open project folder')
  if (!dir) return
  await openWorkspace(dir)
}
export async function openWorkspace(dir: string) {
  for (const p of dirtyPaths()) await saveDoc(p).catch(() => undefined)
  useEditor.getState().reset()
  await useWorkspace.getState().open(dir)
  await useEditor.getState().restore()
  void useAi.getState().loadSessions()
  useAi.getState().newChat()
  void useAi.getState().loadAgents()
  useUi.getState().set({ sidebarView: 'explorer', sidebarVisible: true })
}

async function askAi(prompt: string, o: { selection?: boolean; file?: boolean; agent?: string } = {}) {
  const ctx = await gatherEditorContext()
  const ai = useAi.getState()
  if (o.selection && ctx.selection) await ai.addContext({ id: 'sel-' + Date.now(), kind: 'selection', label: `${basename(ctx.selection.path)}:${ctx.selection.startLine}-${ctx.selection.endLine}`, path: ctx.selection.path, range: { startLine: ctx.selection.startLine, endLine: ctx.selection.endLine }, content: ctx.selection.text, tokens: Math.ceil(ctx.selection.text.length / 3.6), enabled: true, pinned: false, priority: 5, auto: false, once: true })
  revealChat()
  await ai.send(prompt, { agent: o.agent })
}

function activeFile(): string | null { const t = useEditor.getState().activeTab(); return t?.kind === 'file' ? t.path ?? null : null }

async function debugStart(debug: boolean) {
  const d = useDebug.getState()
  await d.loadConfigs()
  const cfgs = useDebug.getState().configs
  let cfg: LaunchConfig | undefined = cfgs.find(c => c.name === useDebug.getState().selectedConfig) ?? cfgs[0]
  const file = activeFile()
  if (!cfg) { toast.warn('Open a project folder first.'); return }
  if (cfg.program?.includes('${file}') && !file) { toast.warn('Open the JavaScript file you want to run first.'); return }
  try {
    useUi.getState().set({ panelVisible: true, panelTab: debug ? 'debug' : 'terminal' })
    await api.debug.start(cfg, debug, { file: file ?? undefined })
    if (debug) useUi.getState().set({ sidebarView: 'run', sidebarVisible: true })
  } catch (e) { toast.error((e as Error).message); cfg = undefined }
}

export function registerAllCommands(): void {
  const ui = () => useUi.getState()
  const ed = () => useEditor.getState()
  registerCommands([
    // ── palette
    { id: 'palette.commands', title: 'Show All Commands', category: 'View', keybinding: 'Mod+Shift+P', hidden: true, run: () => ui().openPalette('>') },
    { id: 'palette.files', title: 'Go to File…', category: 'Go', keybinding: 'Mod+P', run: () => ui().openPalette('') },
    { id: 'palette.symbols', title: 'Go to Symbol in File…', category: 'Go', keybinding: 'Mod+Shift+O', run: () => ui().openPalette('@') },
    { id: 'palette.workspaceSymbols', title: 'Go to Symbol in Project…', category: 'Go', keybinding: 'Mod+T', run: () => ui().openPalette('#') },
    { id: 'palette.goToLine', title: 'Go to Line…', category: 'Go', keybinding: 'Mod+G', run: () => ui().openPalette(':') },
    // ── views
    view('view.explorer', 'explorer', 'Show Explorer', 'Mod+Shift+E'), view('view.search', 'search', 'Show Search', 'Mod+Shift+F'), view('view.scm', 'scm', 'Show Source Control', 'Mod+Shift+G'),
    view('view.run', 'run', 'Show Run and Debug', 'Mod+Shift+D'), view('view.extensions', 'extensions', 'Show Extensions', 'Mod+Shift+X'), view('view.ai', 'ai', 'Show AI Chats'),
    view('view.agents', 'agents', 'Show Agents'), view('view.models', 'models', 'Show Models'), view('view.images', 'images', 'Show Image Library'), view('view.github', 'github', 'Show GitHub'),
    { id: 'search.findInFiles', title: 'Find in Files', category: 'Search', keybinding: 'Mod+Shift+F', run: () => { ui().showView('search'); setTimeout(() => window.dispatchEvent(new Event('tgg:focus-search')), 60) } },
    { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', keybinding: 'Mod+B', run: () => ui().toggleSidebar() },
    { id: 'view.togglePanel', title: 'Toggle Bottom Panel', category: 'View', keybinding: 'Mod+J', run: () => ui().togglePanel() },
    { id: 'view.toggleAi', title: 'Toggle Side Chat (beside the files)', category: 'View', keybinding: 'Mod+Alt+B', run: () => ui().toggleAi() },
    { id: 'view.chatFocus', title: 'Focus Mode: Chat Only / Restore Layout', category: 'View', keybinding: 'Mod+Alt+C', run: () => { if (ui().chatFocus) ui().set({ chatFocus: false }); else { showChat(); ui().set({ chatFocus: true }); setTimeout(focusComposer, 50) } } },
    { id: 'view.zen', title: 'Toggle Zen Mode', category: 'View', keybinding: 'Mod+K Z', run: () => ui().set({ zen: !ui().zen }) },
    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', keybinding: 'Mod+=', run: () => { const z = Math.min(1.6, +(useSettings.getState().settings.appearance.uiScale + 0.1).toFixed(2)); void useSettings.getState().update({ appearance: { uiScale: z } }) } },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', keybinding: 'Mod+-', run: () => { const z = Math.max(0.7, +(useSettings.getState().settings.appearance.uiScale - 0.1).toFixed(2)); void useSettings.getState().update({ appearance: { uiScale: z } }) } },
    { id: 'view.zoomReset', title: 'Reset Zoom', category: 'View', keybinding: 'Mod+0', run: () => void useSettings.getState().update({ appearance: { uiScale: 1 } }) },
    { id: 'view.fullscreen', title: 'Toggle Full Screen', category: 'View', keybinding: 'F11', run: () => { void api.window.setFullScreen(!document.fullscreenElement && !window.matchMedia('(display-mode: fullscreen)').matches) } },
    { id: 'view.devtools', title: 'Toggle Developer Tools', category: 'Help', run: () => void api.window.toggleDevTools() },
    { id: 'view.notifications', title: 'Show Notifications', category: 'View', run: () => void dialogs.custom({ title: 'Notifications', render: close => createElement('div', { style: { maxHeight: 360, overflow: 'auto' } }, useUi.getState().notifications.length ? useUi.getState().notifications.map(n => createElement('div', { key: n.id, style: { padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--fg)' } }, n.message)) : createElement('div', { className: 'subtle', style: { padding: 12 } }, 'No notifications'), createElement('div', { style: { marginTop: 12, textAlign: 'right' } }, createElement('button', { className: 'btn secondary sm', onClick: () => { useUi.setState({ notifications: [] }); close() } }, 'Clear all'))) }) },
    { id: 'view.theme', title: 'Change Color Theme…', category: 'Preferences', run: async () => { const t = await pick({ title: 'Theme', items: allThemes().map(t => ({ label: t.name, description: t.kind, value: t.id })) }); if (t) void useSettings.getState().update({ appearance: { theme: t } }) } },
    // ── file
    { id: 'file.openFolder', title: 'Open Folder…', category: 'File', keybinding: 'Mod+O', run: openFolder },
    { id: 'file.closeFolder', title: 'Close Folder', category: 'File', run: async () => { ed().reset(); await useWorkspace.getState().close() } },
    { id: 'file.newFile', title: 'New File…', category: 'File', keybinding: 'Mod+N', run: async () => {
      const root = useWorkspace.getState().root
      if (!root) { toast.warn('Open a folder first.'); return }
      const name = await dialogs.prompt({ title: 'New file', message: `Created in ${basename(root)}. Use folders like src/utils/helpers.ts to create nested paths.`, placeholder: 'filename.ext', confirmLabel: 'Create', validate: v => (v.trim() ? null : 'Enter a file name') })
      if (!name) return
      const path = joinPath(root, name.trim())
      try { await api.fs.createFile(path); await useWorkspace.getState().expandTo(path); await useWorkspace.getState().loadDir(dirname(path), true); await ed().openFile(path, { pin: true }) } catch (e) { toast.error((e as Error).message) }
    } },
    { id: 'file.save', title: 'Save', category: 'File', keybinding: 'Mod+S', run: async () => { const p = activeFile(); if (p) try { await saveDoc(p) } catch (e) { toast.error(`Save failed: ${(e as Error).message}`) } } },
    { id: 'file.saveAll', title: 'Save All', category: 'File', keybinding: 'Mod+Alt+S', run: async () => { const n = await saveAll(); if (n) toast.success(`Saved ${n} file${n > 1 ? 's' : ''}`) } },
    { id: 'file.closeTab', title: 'Close Editor', category: 'File', keybinding: 'Mod+W', run: () => { const s = ed(); const g = s.groups[s.activeGroup]; if (g?.activeId) void s.closeTab(g.id, g.activeId) } },
    { id: 'file.closeAll', title: 'Close All Editors', category: 'File', keybinding: 'Mod+K Mod+W', run: () => void ed().closeAll() },
    { id: 'file.reopenClosed', title: 'Reopen Closed Editor', category: 'File', keybinding: 'Mod+Shift+T', run: () => ed().reopenClosed() },
    { id: 'app.quit', title: 'Quit', category: 'File', run: () => void api.app.quit() },
    // ── editor
    { id: 'editor.splitRight', title: 'Split Editor Right', category: 'View', keybinding: 'Mod+\\', run: () => ed().split('row') },
    { id: 'editor.splitDown', title: 'Split Editor Down', category: 'View', keybinding: 'Mod+K Mod+\\', run: () => ed().split('col') },
    { id: 'editor.nextTab', title: 'Next Editor', category: 'View', keybinding: 'Ctrl+Tab', run: () => cycleTab(1) },
    { id: 'editor.prevTab', title: 'Previous Editor', category: 'View', keybinding: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
    { id: 'editor.format', title: 'Format Document', category: 'Editor', keybinding: 'Shift+Alt+F', run: () => void activeMonacoEditor()?.getAction('editor.action.formatDocument')?.run() },
    { id: 'editor.revealInExplorer', title: 'Reveal Active File in Explorer', category: 'File', run: () => { const p = activeFile(); if (p) { void useWorkspace.getState().expandTo(p); ui().showView('explorer') } } },
    { id: 'editor.copyPath', title: 'Copy Path of Active File', category: 'File', run: () => { const p = activeFile(); if (p) void navigator.clipboard.writeText(p) } },
    { id: 'editor.preview', title: 'Open Markdown Preview', category: 'Editor', keybinding: 'Mod+K V', run: () => { const p = activeFile(); if (p && /\.mdx?$/i.test(p)) ed().openPage('home', { key: 'md:' + p, markdown: p }, `Preview ${basename(p)}`) } },
    // ── nav
    { id: 'nav.back', title: 'Go Back', category: 'Go', keybinding: 'Alt+Left', run: () => ed().navigate(-1) },
    { id: 'nav.forward', title: 'Go Forward', category: 'Go', keybinding: 'Alt+Right', run: () => ed().navigate(1) },
    // ── terminal
    { id: 'terminal.new', title: 'New Terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+`', run: () => void useTerminals.getState().create() },
    { id: 'terminal.toggle', title: 'Toggle Terminal', category: 'Terminal', keybinding: 'Ctrl+`', run: async () => { const u = ui(); if (u.panelVisible && u.panelTab === 'terminal') u.set({ panelVisible: false }); else { u.set({ panelVisible: true, panelTab: 'terminal' }); await useTerminals.getState().ensure() } } },
    { id: 'terminal.kill', title: 'Kill Active Terminal', category: 'Terminal', run: () => { const id = useTerminals.getState().active; if (id) void useTerminals.getState().kill(id) } },
    { id: 'view.problems', title: 'Show Problems', category: 'View', keybinding: 'Mod+Shift+M', run: () => ui().togglePanel('problems') },
    { id: 'view.output', title: 'Show Output', category: 'View', run: () => ui().togglePanel('output') },
    // ── debug
    { id: 'debug.start', title: 'Start Debugging', category: 'Run', keybinding: 'F5', run: () => debugStart(true) },
    { id: 'debug.run', title: 'Run Without Debugging', category: 'Run', keybinding: 'Ctrl+F5', run: () => debugStart(false) },
    { id: 'debug.stop', title: 'Stop Debugging', category: 'Run', keybinding: 'Shift+F5', run: () => void api.debug.stop() },
    { id: 'debug.restart', title: 'Restart Debugging', category: 'Run', keybinding: 'Mod+Shift+F5', run: () => void api.debug.restart().catch(e => toast.error((e as Error).message)) },
    { id: 'debug.continue', title: 'Continue', category: 'Run', run: () => void api.debug.resume() },
    { id: 'debug.stepOver', title: 'Step Over', category: 'Run', keybinding: 'F10', run: () => void api.debug.stepOver() },
    { id: 'debug.stepInto', title: 'Step Into', category: 'Run', keybinding: 'F11', run: () => void api.debug.stepInto() },
    { id: 'debug.stepOut', title: 'Step Out', category: 'Run', keybinding: 'Shift+F11', run: () => void api.debug.stepOut() },
    { id: 'debug.toggleBreakpoint', title: 'Toggle Breakpoint', category: 'Run', keybinding: 'F9', run: () => { const e = activeMonacoEditor(); const p = activeFile(); const l = e?.getPosition()?.lineNumber; if (p && l) void useDebug.getState().toggleBreakpoint(p, l) } },
    // ── git
    { id: 'git.checkout', title: 'Checkout Branch…', category: 'Git', run: async () => {
      const branches = await api.git.branches().catch(() => [])
      const v = await pick<string>({ title: 'Branch', placeholder: 'Select a branch or type a new name to create it', allowCustom: true, items: branches.map(b => ({ label: b.name, description: b.current ? 'current' : b.remote ? 'remote' : b.subject, value: b.name, separator: b.remote ? 'Remote branches' : 'Local branches' })) })
      if (!v) return
      const exists = branches.some(b => b.name === v)
      try { await useGit.getState().run('checkout', () => api.git.checkout(v, !exists)); toast.success(exists ? `Switched to ${v}` : `Created and switched to ${v}`) } catch (e) { toast.error((e as Error).message) }
    } },
    { id: 'git.sync', title: 'Sync (Pull & Push)', category: 'Git', run: async () => { try { await useGit.getState().run('sync', async () => { await api.git.pull(); await api.git.push() }); toast.success('Synced with remote') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'git.fetch', title: 'Fetch', category: 'Git', run: async () => { try { await useGit.getState().run('fetch', () => api.git.fetch()); toast.success('Fetched') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'git.pull', title: 'Pull', category: 'Git', run: async () => { try { toast.info(await useGit.getState().run('pull', () => api.git.pull()) ?? 'Pulled') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'git.push', title: 'Push', category: 'Git', run: async () => { try { await useGit.getState().run('push', () => api.git.push()); toast.success('Pushed') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'git.stageAll', title: 'Stage All Changes', category: 'Git', run: () => void useGit.getState().run('stage', () => api.git.stageAll()) },
    { id: 'git.stash', title: 'Stash Changes…', category: 'Git', run: async () => { const m = await dialogs.prompt({ title: 'Stash changes', placeholder: 'Optional message' }); if (m !== null) try { await useGit.getState().run('stash', () => api.git.stashPush(m || undefined, true)); toast.success('Changes stashed') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'git.init', title: 'Initialize Repository', category: 'Git', run: async () => { await api.git.init(); void useGit.getState().refresh() } },
    { id: 'git.clone', title: 'Clone Repository…', category: 'Git', run: async () => {
      const url = await dialogs.prompt({ title: 'Clone repository', message: 'Paste the repository URL (https or ssh).', placeholder: 'https://github.com/owner/repo.git', confirmLabel: 'Choose folder…', validate: v => (v.trim() ? null : 'Enter a URL') })
      if (!url) return
      const dest = await api.fs.pickFolder('Choose where to clone into')
      if (!dest) return
      const id = ui().toast({ kind: 'info', message: 'Cloning…', sticky: true })
      try { const dir = await api.git.clone(url.trim(), dest); ui().dismissToast(id); toast.success('Cloned'); await openWorkspace(dir) } catch (e) { ui().dismissToast(id); toast.error((e as Error).message) }
    } },
    // ── ai
    { id: 'ai.newChat', title: 'New AI Chat', category: 'AI', keybinding: 'Mod+Shift+N', run: async () => { await useAi.getState().newChat(); revealChat(); setTimeout(focusComposer, 50) } },
    { id: 'ai.focus', title: 'Go to Chat', category: 'AI', keybinding: 'Mod+I', run: () => { revealChat(); setTimeout(focusComposer, 30) } },
    { id: 'ai.stop', title: 'Stop AI Generation', category: 'AI', run: () => void useAi.getState().abort() },
    { id: 'ai.compact', title: 'Compact Conversation (summarize history)', category: 'AI', run: async () => { const id = useAi.getState().active; if (!id) return; try { toast.info((await api.ai.compact(id)) ? 'Conversation compacted' : 'Nothing to compact yet') } catch (e) { toast.error((e as Error).message) } } },
    { id: 'ai.undo', title: 'Undo Last AI Changes', category: 'AI', keybinding: 'Mod+Alt+Z', run: async () => { const id = useAi.getState().active; if (!id) return; const r = await api.ai.changes.undoLastTurn(id); toast.info(r.reverted ? `Reverted ${r.files.length} file${r.files.length > 1 ? 's' : ''}` : 'No AI changes to undo') } },
    { id: 'ai.redo', title: 'Redo AI Changes', category: 'AI', run: async () => { const id = useAi.getState().active; if (!id) return; const r = await api.ai.changes.redo(id); toast.info(r.applied ? 'Changes re-applied' : 'Nothing to redo') } },
    { id: 'ai.cycleMode', title: 'Cycle Permission Mode', category: 'AI', run: () => { const order: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'yolo']; const cur = useAi.getState().composer.mode; useAi.getState().setComposer({ mode: order[(order.indexOf(cur) + 1) % order.length] }) } },
    { id: 'ai.addSelection', title: 'Add Selection to AI Chat', category: 'AI', keybinding: 'Mod+Shift+L', run: async () => { const c = await gatherEditorContext(); if (!c.selection) { toast.info('Select some code first.'); return } await useAi.getState().addContext({ id: 'sel-' + Date.now(), kind: 'selection', label: `${basename(c.selection.path)}:${c.selection.startLine}-${c.selection.endLine}`, path: c.selection.path, range: { startLine: c.selection.startLine, endLine: c.selection.endLine }, content: c.selection.text, tokens: Math.ceil(c.selection.text.length / 3.6), enabled: true, pinned: false, priority: 5, auto: false }); revealChat(); setTimeout(focusComposer, 50) } },
    { id: 'ai.addFile', title: 'Add Active File to AI Chat', category: 'AI', run: async () => { const p = activeFile(); if (p) { await useAi.getState().addContext(await api.ai.context.describe(p)); revealChat() } } },
    { id: 'ai.explain', title: 'AI: Explain Selection', category: 'AI', run: () => askAi('Explain this code: what it does, how it works, and anything non-obvious or risky.', { selection: true }) },
    { id: 'ai.refactor', title: 'AI: Refactor Selection', category: 'AI', run: () => askAi('Refactor the selected code to be clearer and more maintainable without changing its behaviour. Apply the change to the file.', { selection: true }) },
    { id: 'ai.tests', title: 'AI: Write Tests for Selection', category: 'AI', run: () => askAi('Write thorough tests for the selected code using the project’s existing test setup, then run them.', { selection: true }) },
    { id: 'ai.docsComment', title: 'AI: Document Selection', category: 'AI', run: () => askAi('Add clear documentation comments to the selected code, following the language and project conventions. Do not change behaviour.', { selection: true }) },
    { id: 'ai.fix', title: 'AI: Fix Problems in File', category: 'AI', run: () => askAi('Fix all the errors and warnings reported for the current file, then verify the fix.') },
    { id: 'ai.history', title: 'Open Chat History', category: 'AI', run: () => ui().showView('ai') },
    // ── settings & misc
    { id: 'settings.open', title: 'Open Settings', category: 'Preferences', keybinding: 'Mod+,', run: () => ed().openPage('settings') },
    { id: 'settings.keybindings', title: 'Keyboard Shortcuts', category: 'Preferences', keybinding: 'Mod+K Mod+S', run: () => ed().openPage('settings', { section: 'keybindings' }) },
    { id: 'settings.models', title: 'Manage Models & Providers', category: 'Preferences', run: () => ed().openPage('models') },
    { id: 'settings.languages', title: 'Language Servers', category: 'Preferences', run: () => ed().openPage('settings', { section: 'languages' }) },
    { id: 'bench.open', title: 'Benchmark Models', category: 'AI', run: () => ed().openPage('bench') },
    { id: 'images.open', title: 'Open Image Studio', category: 'AI', run: () => ed().openPage('images') },
    { id: 'home.open', title: 'Open Home / Welcome', category: 'Help', run: () => showChat() },
    { id: 'help.checkUpdates', title: 'Check for Updates…', category: 'Help', run: async () => {
      const s = await useUpdate.getState().check(true)
      if (s.status === 'available') useUpdate.setState({ open: true })
      else if (s.status === 'error') toast.error(s.message)
      else toast.success(`You’re up to date — version ${s.current}.`)
    } },
    { id: 'help.logs', title: 'Open Logs Folder', category: 'Help', run: () => void api.app.openLogs() },
    { id: 'help.userData', title: 'Open Data Folder', category: 'Help', run: () => void api.app.openUserData() },
    { id: 'help.about', title: 'About TGGAGS IDE', category: 'Help', run: async () => { const i = await api.app.info(); await dialogs.alert({ title: 'TGGAGS IDE', message: createElement('div', { className: 'col gap8' }, createElement('div', { className: 'row gap12' }, createElement(Logo, { size: 44 }), createElement('div', null, createElement('div', { style: { color: 'var(--fg)', fontWeight: 600, fontSize: 15 } }, `Version ${i.version}`), createElement('div', { className: 'small' }, 'An AI-native IDE: editor, agents, terminal, Git, debugger and more.'))), createElement('div', { className: 'small mono', style: { lineHeight: 1.7 } }, `Electron ${i.electron} · Chromium ${i.chrome} · Node ${i.node}\n${i.platform} ${i.arch} · ${i.secureStorage ? 'OS keychain secured keys' : 'basic key storage'}\nData: ${i.userData}`)) }) } }
  ])
}

function cycleTab(delta: number) {
  const s = useEditor.getState()
  const g = s.groups[s.activeGroup]
  if (!g?.tabs.length) return
  const i = g.tabs.findIndex(t => t.id === g.activeId)
  s.activate(g.id, g.tabs[(i + delta + g.tabs.length) % g.tabs.length].id)
}
void relativeTo; void runCommand
