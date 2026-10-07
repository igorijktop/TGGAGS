import { useAi } from '../../stores/ai'
import { Home } from '../home/Home'
import { ChatPanel } from './ChatPanel'

/**
 * The content of the permanent “Chat” tab in the main window: the welcome screen while the current chat is still empty,
 * the full conversation as soon as there is something to read (or the agent is already working on it).
 */
export function MainChat() {
  const started = useAi(s => !!s.active && ((s.data[s.active]?.messages.length ?? 0) > 0 || !!s.running[s.active]))
  return started ? <ChatPanel variant="page" /> : <Home />
}
