import { useState } from 'react'
import { Heart, ImageIcon, Plus, Upload } from 'lucide-react'
import { api } from '../../lib/api'
import { cn } from '../../lib/util'
import { Button, EmptyState, IconButton, Segmented } from '../../components/ui'
import { useEditor } from '../../stores/editor'
import { toast } from '../../stores/ui'
import { Thumb, useAssets } from './assets'

export function ImagesView() {
  const { assets } = useAssets()
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')
  const list = assets.filter(a => filter === 'all' || a.favorite)
  const open = (id?: string) => useEditor.getState().openPage('images', id ? { asset: id } : undefined, 'Image studio')
  const importFiles = async () => { const ps = await api.fs.pickFiles('Import images', [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }], true); if (ps.length) { const r = await api.images.importFiles(ps); toast.success(`Imported ${r.length} image${r.length === 1 ? '' : 's'}.`) } }
  return <>
    <div className="sb-head"><h2>Image studio</h2><IconButton icon={Upload} size="sm" tip="Import images" onClick={() => void importFiles()} /><IconButton icon={Plus} size="sm" tip="Create an image" onClick={() => open()} /></div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><Button variant="primary" icon={ImageIcon} style={{ width: '100%' }} onClick={() => open()}>Open studio</Button></div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><Segmented<'all' | 'favorites'> value={filter} options={[{ value: 'all', label: `All (${assets.length})` }, { value: 'favorites', label: 'Favourites' }]} onChange={setFilter} /></div>
    <div className="sb-body">
      {list.length === 0 ? <EmptyState icon={ImageIcon} title={assets.length ? 'No favourites yet' : 'No images yet'} text={assets.length ? 'Tap the heart on an image to keep it here.' : 'Generate pictures from a description, edit existing ones, or import your own.'} />
        : <div className="thumb-grid">{list.map(a => <button key={a.id} className="tg-item" onClick={() => open(a.id)} data-tip={a.prompt || a.name}><Thumb id={a.id} alt={a.name} />{a.favorite && <Heart size={12} className="tg-fav" fill="currentColor" />}<span className={cn('tg-kind', a.kind)}>{a.kind === 'generated' ? '' : a.kind}</span></button>)}</div>}
    </div>
  </>
}
