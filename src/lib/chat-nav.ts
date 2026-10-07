import { useEditor, CHAT_TAB_ID } from '../stores/editor'
import { useUi } from '../stores/ui'

/** True while the conversation is on screen in the main window (any editor group). */
export function chatInMain(): boolean {
  return Object.values(useEditor.getState().groups).some(g => g.activeId === CHAT_TAB_ID)
}

/** Bring the conversation to the main window and leave focus mode. */
export function showChat(): void {
  useUi.getState().set({ chatFocus: false })
  useEditor.getState().openPage('chat')
}

/**
 * Make sure the user can see the chat after something was sent to it from elsewhere (a command, "Fix with AI" …).
 * If the optional side chat is already open beside the files they are looking at, nothing moves.
 */
export function revealChat(): void {
  const ui = useUi.getState()
  if (ui.aiVisible && !ui.chatFocus && !chatInMain()) return
  showChat()
}

export const focusComposer = () => window.dispatchEvent(new Event('tgg:focus-composer'))
