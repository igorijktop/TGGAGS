import { useEffect } from 'react'
import { useUi } from '../../stores/ui'
import { cn } from '../../lib/util'
import { Resizer } from '../../components/ui'
import { TopBar } from './TopBar'
import { ActivityBar } from './ActivityBar'
import { StatusBar } from './StatusBar'
import { Sidebar } from './Sidebar'
import { EditorArea } from '../editor/EditorArea'
import { ChatPanel } from '../ai/ChatPanel'
import { useEditor, CHAT_TAB_ID } from '../../stores/editor'
import { BottomPanel } from '../panels/BottomPanel'
import { useSettings } from '../../stores/settings'
import { clamp } from '../../lib/util'

export function Shell() {
  const ui = useUi()
  const update = useSettings(s => s.update)
  const persist = () => { const s = useUi.getState(); void update({ ui: { sidebarWidth: s.sidebarWidth, aiPanelWidth: s.aiWidth, panelHeight: s.panelHeight, sidebarVisible: s.sidebarVisible, aiPanelVisible: s.aiVisible, panelVisible: s.panelVisible, lastView: s.sidebarView } } as never) }
  useEffect(() => { const t = setTimeout(persist, 600); return () => clearTimeout(t) }, [ui.sidebarVisible, ui.aiVisible, ui.panelVisible, ui.sidebarView]) // eslint-disable-line react-hooks/exhaustive-deps
  const focus = ui.chatFocus
  // The conversation lives in the main window. The narrow side chat is an optional extra for when you look at files,
  // so it steps aside while the Chat tab itself is showing (it would only repeat the same conversation).
  const chatInMain = useEditor(st => Object.values(st.groups).some(g => g.activeId === CHAT_TAB_ID))
  const sideChat = ui.aiVisible && !focus && !chatInMain
  return (
    <div className={cn('app', ui.zen && 'zen', !ui.sidebarVisible && 'no-sidebar')}>
      <TopBar />
      <div className="body">
        <ActivityBar />
        {ui.sidebarVisible && !focus && <>
          <aside className="sidebar" style={{ width: ui.sidebarWidth }} aria-label="Sidebar"><Sidebar /></aside>
          <Resizer dir="v" onDrag={d => ui.set({ sidebarWidth: clamp(useUi.getState().sidebarWidth + d, 200, 620) })} onCommit={persist} />
        </>}
        <div className="workbench" style={ui.sidebarVisible && !focus ? { borderTopLeftRadius: 12 } : undefined}>
          <div className="main-col">
            <EditorArea />
            {ui.panelVisible && !focus && <>
              <Resizer dir="h" onDrag={d => ui.set({ panelHeight: clamp(useUi.getState().panelHeight - d, 120, window.innerHeight - 200) })} onCommit={persist} />
              <BottomPanel />
            </>}
          </div>
          {sideChat && <>
            <Resizer dir="v" onDrag={d => ui.set({ aiWidth: clamp(useUi.getState().aiWidth - d, 320, 900) })} onCommit={persist} />
            <aside className="ai-panel" style={{ width: ui.aiWidth }} aria-label="Side chat"><ChatPanel /></aside>
          </>}
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
