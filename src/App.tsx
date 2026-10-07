import { useEffect, useState } from 'react'
import { Shell } from './features/shell/Shell'
import { Palette } from './features/shell/Palette'
import { ContextMenuHost, DialogHost, ToastHost, TooltipHost } from './components/ui'
import { useSettings } from './stores/settings'
import { useWorkspace } from './stores/workspace'
import { useEditor } from './stores/editor'
import { useUi } from './stores/ui'
import { useAi } from './stores/ai'
import { useUpdate } from './stores/update'
import { applyAppearance, applyTheme, setExtraThemes } from './lib/theme'
import { defineMonacoTheme, monaco } from './lib/monaco'
import { findTheme } from './lib/theme'
import { installKeybindings, setUserKeybindings } from './lib/commands'
import { registerAllCommands } from './commands'
import { registerLspProviders } from './lib/lsp-monaco'
import { startDocWatchers } from './lib/docs'
import { initEditorIntegrations } from './features/editor/init'
import { initGit } from './stores/git'
import { initLspStatus } from './stores/lsp'
import { initDebug } from './stores/debug'
import { initTerminals } from './stores/terminal'
import { api, onEvent } from './lib/api'
import { Onboarding } from './features/home/Onboarding'

export function App() {
  const [ready, setReady] = useState(false)
  const theme = useSettings(s => s.settings.appearance.theme)
  const appearance = useSettings(s => s.settings.appearance)
  const kb = useSettings(s => s.settings.keybindings)
  const loaded = useSettings(s => s.loaded)
  const onboarded = useSettings(s => s.settings.ui.onboarded)

  useEffect(() => {
    void (async () => {
      await useSettings.getState().load()
      const s = useSettings.getState().settings
      // Earlier versions docked the conversation on the right; it now lives in the main window, so the side chat starts closed once.
      const oldLayout = (s.ui.layoutVersion ?? 0) < 2
      if (oldLayout) void useSettings.getState().update({ ui: { layoutVersion: 2, aiPanelVisible: false } } as never)
      useUi.setState({ sidebarWidth: s.ui.sidebarWidth, aiWidth: s.ui.aiPanelWidth, panelHeight: s.ui.panelHeight, sidebarVisible: s.ui.sidebarVisible, aiVisible: oldLayout ? false : s.ui.aiPanelVisible, panelVisible: s.ui.panelVisible, sidebarView: (s.ui.lastView as never) || 'explorer' })
      try { setExtraThemes(await api.extensions.themes()) } catch { /* optional */ }
      registerAllCommands(); registerLspProviders(); startDocWatchers(); initEditorIntegrations()
      await useWorkspace.getState().init()
      initGit(); initLspStatus(); initDebug(); initTerminals()
      await useAi.getState().init(); void useAi.getState().loadSessions()
      void useUpdate.getState().init()
      installKeybindings()
      onEvent('app:open-path', p => { if (!p.isDir) void useEditor.getState().openFile(p.path, { pin: true }) })
      onEvent('ext:changed', () => { void api.extensions.themes().then(t => { setExtraThemes(t); applyThemeNow(useSettings.getState().settings.appearance.theme) }) })
      onEvent('app:notify', n => useUi.getState().toast({ kind: n.level === 'warn' ? 'warn' : n.level, message: n.source ? `${n.source}: ${n.message}` : n.message }))
      await useEditor.getState().restore()
      setReady(true)
    })()
  }, [])

  useEffect(() => { if (loaded) applyThemeNow(theme) }, [theme, loaded])
  useEffect(() => { if (loaded) applyAppearance(appearance) }, [appearance, loaded])
  useEffect(() => { setUserKeybindings(kb) }, [kb])

  if (!ready || !loaded) return <div className="splash"><div className="spinner" /></div>
  return (
    <>
      <Shell />
      <Palette />
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
      <TooltipHost />
      {!onboarded && <Onboarding />}
    </>
  )
}

function applyThemeNow(id: string) { const t = applyTheme(id); monaco.editor.setTheme(defineMonacoTheme(findTheme(t.id))) }
