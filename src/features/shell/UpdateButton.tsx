import { useEffect, useState } from 'react'
import { ArrowUpCircle, Download, RotateCw, TriangleAlert } from 'lucide-react'
import { Button, Popover } from '../../components/ui'
import { formatBytes } from '../../lib/util'
import { Markdown } from '../ai/Markdown'
import { useUpdate } from '../../stores/update'

/** Shown in the title bar only when a newer version exists (or is being downloaded). */
export function UpdateButton() {
  const state = useUpdate(s => s.state)
  const open = useUpdate(s => s.open)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const set = useUpdate.setState
  useEffect(() => { if (state && !('info' in state && state.info)) set({ open: false }) }, [state, set])
  if (!state || !('info' in state) || !state.info) return null
  const info = state.info
  const pct = state.status === 'downloading' ? Math.min(100, Math.round((state.received / info.size) * 100)) : 0
  const { start, cancel, install } = useUpdate.getState()
  const label = state.status === 'downloading' ? `Downloading ${pct}%` : state.status === 'ready' ? 'Restart to update' : state.status === 'error' ? 'Update failed' : 'Update'
  const Icon = state.status === 'error' ? TriangleAlert : state.status === 'ready' ? RotateCw : state.status === 'downloading' ? Download : ArrowUpCircle
  return <>
    <span ref={setEl} className="update-wrap"><Button variant="primary" size="sm" icon={Icon} className="update-btn" style={{ ['--p' as string]: `${pct}%` }} onClick={() => set({ open: !open })} tip={`Version ${info.version} is available`} aria-label="Update available">{label}</Button></span>
    {open && el && <Popover anchor={el} placement="bottom-end" width={380} onClose={() => set({ open: false })}>
      <div className="update-pop">
        <div className="up-head"><ArrowUpCircle size={20} /><div><b>Update available</b><div className="subtle small">Version {state.current} → <b>{info.version}</b> · {formatBytes(info.size)}{info.date ? ` · ${info.date}` : ''}</div></div></div>
        {info.notes && <div className="up-notes selectable"><Markdown text={info.notes} className="msg-text" /></div>}
        {state.status === 'downloading' && <div className="up-progress" role="progressbar" aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>}
        {state.status === 'downloading' && <div className="subtle small">{formatBytes(state.received)} of {formatBytes(info.size)}</div>}
        {state.status === 'error' && <div className="msg-error"><TriangleAlert size={14} /><span className="selectable">{state.message}</span></div>}
        <div className="up-actions">
          {state.status === 'available' && <><Button variant="primary" icon={Download} onClick={() => void start()}>Update now</Button><Button variant="ghost" onClick={() => set({ open: false })}>Later</Button></>}
          {state.status === 'downloading' && <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>}
          {state.status === 'ready' && <><Button variant="primary" icon={RotateCw} onClick={() => void install()}>Restart and update</Button><Button variant="ghost" onClick={() => set({ open: false })}>Later</Button></>}
          {state.status === 'error' && <><Button variant="primary" onClick={() => void start()}>Try again</Button><Button variant="ghost" onClick={() => set({ open: false })}>Close</Button></>}
        </div>
        <div className="subtle small">Your settings, chats and projects are kept. The app restarts when the update is installed.</div>
      </div>
    </Popover>}
  </>
}
