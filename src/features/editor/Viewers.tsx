import { useEffect, useState } from 'react'
import { ExternalLink, FileWarning } from 'lucide-react'
import { api } from '../../lib/api'
import { formatBytes, toFileUrl } from '../../lib/util'
import { Button } from '../../components/ui'
import type { Tab } from '../../stores/editor'

export function ImageViewer({ tab }: { tab: Tab }) {
  const [dim, setDim] = useState<string>('')
  return (
    <>
      <div className="diff-toolbar"><span className="truncate" style={{ fontWeight: 500 }}>{tab.title}</span><span className="subtle small">{dim}</span><div className="grow" /><Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void api.fs.openPath(tab.path!)}>Open externally</Button></div>
      <div className="viewer"><img src={toFileUrl(tab.path!)} alt={tab.title} onLoad={e => setDim(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /></div>
    </>
  )
}

export function MediaViewer({ tab }: { tab: Tab }) {
  const url = toFileUrl(tab.path!)
  const ext = tab.path!.split('.').pop()?.toLowerCase()
  const [size, setSize] = useState(0)
  useEffect(() => { void api.fs.stat(tab.path!).then(s => setSize(s.size)) }, [tab.path])
  return (
    <>
      <div className="diff-toolbar"><span className="truncate" style={{ fontWeight: 500 }}>{tab.title}</span><span className="subtle small">{size ? formatBytes(size) : ''}</span><div className="grow" /><Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void api.fs.openPath(tab.path!)}>Open externally</Button></div>
      <div className="viewer" style={{ padding: ext === 'pdf' ? 0 : 24 }}>
        {ext === 'pdf' ? <iframe src={url} title={tab.title} style={{ width: '100%', height: '100%', border: 0 }} />
          : ['mp3', 'wav', 'ogg'].includes(ext!) ? <audio controls src={url} />
          : <video controls src={url} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} />}
      </div>
    </>
  )
}

export function BinaryNotice({ tab }: { tab: Tab }) {
  return (
    <div className="editor-empty">
      <FileWarning size={32} strokeWidth={1.4} />
      <div style={{ color: 'var(--fg)', fontWeight: 500 }}>{tab.title}</div>
      <div style={{ maxWidth: 360, textAlign: 'center', lineHeight: 1.5 }}>{tab.note}</div>
      <Button icon={ExternalLink} onClick={() => void api.fs.openPath(tab.path!)}>Open with system app</Button>
    </div>
  )
}
