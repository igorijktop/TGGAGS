import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, Eraser, Eye, FileSearch, FolderInput, Heart, ImageIcon, Loader2, Maximize2, Sparkles, Square, Trash2, Wand2, ZoomIn, Upload, X } from 'lucide-react'
import type { ImageRequest } from '@shared/media'
import type { ModelRef } from '@shared/settings'
import { api } from '../../lib/api'
import { cn, copyText, formatBytes, timeAgo } from '../../lib/util'
import { Badge, Button, EmptyState, IconButton, Segmented } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { useSettings } from '../../stores/settings'
import { useEditor } from '../../stores/editor'
import { ModelPicker, useChatModels } from '../ai/Selectors'
import { Thumb, assetUrl, useAssetUrl, useAssets } from './assets'

type Mode = 'generate' | 'edit' | 'variation'
const RATIOS: { id: string; label: string; size: string }[] = [
  { id: '1:1', label: 'Square', size: '1024x1024' }, { id: '3:2', label: 'Landscape', size: '1536x1024' }, { id: '2:3', label: 'Portrait', size: '1024x1536' },
  { id: '16:9', label: 'Wide', size: '1792x1024' }, { id: '9:16', label: 'Tall', size: '1024x1792' }
]

// ───────────── mask painter (edit mode) ─────────────
function MaskCanvas({ url, brush, onReady }: { url: string; brush: number; onReady(api: { clear(): void; export(protocol: string): { mime: string; data: string } | null; hasPaint(): boolean }): void }) {
  const img = useRef<HTMLImageElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const painted = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const size = useRef({ w: 0, h: 0 })
  const sync = () => { const i = img.current, c = cvs.current; if (!i || !c) return; size.current = { w: i.naturalWidth, h: i.naturalHeight }; if (c.width !== i.naturalWidth) { c.width = i.naturalWidth; c.height = i.naturalHeight } }
  useEffect(() => {
    onReady({
      clear() { const c = cvs.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); painted.current = false },
      hasPaint: () => painted.current,
      export(protocol) {
        const c = cvs.current; if (!c || !painted.current) return null
        const out = document.createElement('canvas'); out.width = c.width; out.height = c.height
        const ctx = out.getContext('2d')!, src = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
        const dst = ctx.createImageData(c.width, c.height)
        const alphaMask = protocol === 'openai'
        for (let i = 0; i < src.data.length; i += 4) {
          const on = src.data[i + 3] > 20
          if (alphaMask) { dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = 0; dst.data[i + 3] = on ? 0 : 255 }
          else { const v = on ? 255 : 0; dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v; dst.data[i + 3] = 255 }
        }
        ctx.putImageData(dst, 0, 0)
        return { mime: 'image/png', data: out.toDataURL('image/png').split(',')[1] }
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const pos = (e: React.PointerEvent) => { const c = cvs.current!, r = c.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height } }
  const draw = (e: React.PointerEvent) => {
    const c = cvs.current!, ctx = c.getContext('2d')!, p = pos(e), scale = c.width / c.getBoundingClientRect().width
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush * scale; ctx.strokeStyle = 'rgba(224,128,93,1)'
    ctx.beginPath(); const l = last.current ?? p; ctx.moveTo(l.x, l.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke(); last.current = p; painted.current = true
  }
  return <div className="mask-wrap">
    <img ref={img} src={url} alt="Image to edit" onLoad={sync} draggable={false} />
    <canvas ref={cvs} className="mask-cvs" onPointerDown={e => { sync(); (e.target as HTMLElement).setPointerCapture(e.pointerId); last.current = null; draw(e) }} onPointerMove={e => { if (e.buttons) draw(e) }} onPointerUp={() => { last.current = null }} />
  </div>
}

// ───────────── page ─────────────
export function ImagesPage({ assetId }: { assetId?: string }) {
  const { assets, reload } = useAssets()
  const providers = useSettings(s => s.settings.providers)
  const defaultModel = useSettings(s => s.settings.images.defaultModel)
  const imageModels = useChatModels('image')
  const [mode, setMode] = useState<Mode>('generate')
  const [model, setModel] = useState<ModelRef | null>(defaultModel)
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const [n, setN] = useState(1)
  const [quality, setQuality] = useState<'auto' | 'low' | 'medium' | 'high'>('auto')
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [seed, setSeed] = useState('')
  const [steps, setSteps] = useState('')
  const [guidance, setGuidance] = useState('')
  const [strength, setStrength] = useState(0.6)
  const [more, setMore] = useState(false)
  const [sel, setSel] = useState<string | null>(assetId ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [text, setText] = useState<{ title: string; body: string } | null>(null)
  const [brush, setBrush] = useState(36)
  const mask = useRef<{ clear(): void; export(p: string): { mime: string; data: string } | null; hasPaint(): boolean } | null>(null)
  const asset = assets.find(a => a.id === sel) ?? null
  const url = useAssetUrl(sel)
  useEffect(() => { if (assetId) setSel(assetId) }, [assetId])
  useEffect(() => { if (!model && imageModels.length) setModel(defaultModel ?? imageModels.find(m => m.ready)?.ref ?? imageModels[0].ref) }, [imageModels.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const protocol = useMemo(() => providers.find(p => p.id === model?.provider)?.protocol ?? 'openai', [providers, model])

  const generate = async () => {
    if (!model) { toast.warn('Choose an image model first.'); return }
    if (!prompt.trim() && mode !== 'variation') { toast.warn('Describe the image you want.'); return }
    if (mode !== 'generate' && !asset) { toast.warn('Select an image first.'); return }
    const req: ImageRequest = { mode, model, prompt: prompt.trim(), negativePrompt: negative.trim() || undefined, size: RATIOS.find(r => r.id === ratio)?.size, aspectRatio: ratio, n, quality, format, strength: mode === 'edit' || mode === 'variation' ? strength : undefined,
      seed: seed ? +seed : undefined, steps: steps ? +steps : undefined, guidance: guidance ? +guidance : undefined, inputAssetId: mode !== 'generate' ? asset!.id : undefined }
    if (mode === 'edit') { const m = mask.current?.export(protocol); if (m) req.maskImage = m }
    setBusy(mode === 'generate' ? 'Creating…' : mode === 'edit' ? 'Editing…' : 'Making variations…')
    try { const out = await api.images.generate(req); reload(); if (out[0]) setSel(out[0].id); toast.success(`Created ${out.length} image${out.length === 1 ? '' : 's'}.`) } catch (e) { toast.error((e as Error).message.replace(/^Error invoking.*?: /, '')) } finally { setBusy(null) }
  }
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn() } catch (e) { toast.error((e as Error).message.replace(/^Error invoking.*?: /, '')) } finally { setBusy(null) } }
  const upscale = (s: number) => act(`Upscaling ×${s}…`, async () => { const a = await api.images.upscale(asset!.id, s); reload(); setSel(a.id) })
  const enlargeLocal = () => act('Enlarging…', async () => {
    const u = await assetUrl(asset!.id); const im = new Image(); im.src = u; await im.decode()
    const c = document.createElement('canvas'); c.width = im.naturalWidth * 2; c.height = im.naturalHeight * 2
    const ctx = c.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(im, 0, 0, c.width, c.height)
    const a = await api.images.importData(`${asset!.name} ×2 (local)`, 'image/png', c.toDataURL('image/png').split(',')[1], 'upscaled', asset!.id, asset!.prompt); reload(); setSel(a.id)
  })
  const describe = () => act('Looking at the image…', async () => setText({ title: 'Description', body: await api.images.describe(asset!.id) }))
  const ocr = () => act('Reading text…', async () => setText({ title: 'Text in the image', body: (await api.images.ocr(asset!.id)) || '(No text found)' }))
  const saveProject = async () => { const rel = await dialogs.prompt({ title: 'Save into the project', message: 'Path relative to the project root.', initial: `assets/${asset!.name.replace(/[^\w.-]+/g, '-')}.${asset!.mime.split('/')[1] ?? 'png'}`, confirmLabel: 'Save' }); if (rel) { const p = await api.images.saveToProject(asset!.id, rel.trim()); toast.success('Saved.'); void useEditor.getState().openFile(p, { pin: true }) } }
  const exportAsset = async () => { const dest = await api.fs.pickSavePath('Save image', `${asset!.name}.${asset!.mime.split('/')[1] ?? 'png'}`); if (dest) { await api.images.exportAsset(asset!.id, dest); toast.success('Saved.') } }
  const remove = async () => { if (await dialogs.confirm({ title: 'Delete this image?', message: 'It is removed from the library.', confirmLabel: 'Delete', danger: true })) { await api.images.deleteAsset(asset!.id); setSel(null); reload() } }
  const importFiles = async () => { const ps = await api.fs.pickFiles('Import images', [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }], true); if (ps.length) { const r = await api.images.importFiles(ps); reload(); if (r[0]) setSel(r[0].id) } }
  const useAsEdit = (m: Mode) => { setMode(m); mask.current?.clear() }

  return <div className="studio">
    <aside className="st-side">
      <Segmented<Mode> value={mode} options={[{ value: 'generate', label: 'Create' }, { value: 'edit', label: 'Edit' }, { value: 'variation', label: 'Variations' }]} onChange={useAsEdit} />
      {mode !== 'generate' && !asset && <div className="st-hint">Pick an image from the library below to {mode === 'edit' ? 'edit' : 'vary'}.</div>}
      <label className="field"><span className="field-label">Model</span><ModelPicker modality="image" value={model} onChange={m => setModel(m)} placement="bottom-start" /></label>
      {mode !== 'variation' && <label className="field"><span className="field-label">{mode === 'edit' ? 'What should change?' : 'Describe the image'}</span><textarea className="textarea" rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={mode === 'edit' ? 'Replace the sky with a dramatic sunset' : 'A cozy cabin in a snowy forest at dusk, warm light in the windows, watercolor style'} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void generate() }} /></label>}
      {mode === 'edit' && <div className="field"><span className="field-label">Paint over the area to change <span className="subtle">(optional)</span></span><div className="row gap8"><input type="range" className="slider" min={8} max={120} value={brush} onChange={e => setBrush(+e.target.value)} style={{ flex: 1 }} /><Button size="sm" variant="ghost" icon={Eraser} onClick={() => mask.current?.clear()}>Clear</Button></div></div>}
      {mode === 'generate' && <div className="field"><span className="field-label">Shape</span><div className="ratio-row">{RATIOS.map(r => <button key={r.id} className={cn('ratio', ratio === r.id && 'on')} onClick={() => setRatio(r.id)} data-tip={`${r.label} · ${r.size}`}><i style={{ aspectRatio: r.id.replace(':', '/') }} /><span>{r.id}</span></button>)}</div></div>}
      {mode !== 'edit' && <div className="field"><span className="field-label">How many</span><Segmented<string> value={String(n)} options={[1, 2, 3, 4].map(x => ({ value: String(x), label: String(x) }))} onChange={v => setN(+v)} /></div>}
      {(mode === 'edit' || mode === 'variation') && <div className="field"><span className="field-label">Change strength · {Math.round(strength * 100)}%</span><input type="range" className="slider" style={{ width: '100%' }} min={0.1} max={1} step={0.05} value={strength} onChange={e => setStrength(+e.target.value)} /></div>}
      <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(!more)}>{more ? 'Hide' : 'More'} options</button>
      {more && <div className="col gap8 fade-in">
        <label className="field"><span className="field-label">Avoid (negative prompt)</span><input className="input sm" value={negative} onChange={e => setNegative(e.target.value)} placeholder="blurry, text, watermark" /></label>
        <div className="row gap8"><label className="field grow"><span className="field-label">Quality</span><select className="select sm" value={quality} onChange={e => setQuality(e.target.value as typeof quality)}>{['auto', 'low', 'medium', 'high'].map(q => <option key={q}>{q}</option>)}</select></label><label className="field grow"><span className="field-label">Format</span><select className="select sm" value={format} onChange={e => setFormat(e.target.value as typeof format)}>{['png', 'jpeg', 'webp'].map(q => <option key={q}>{q}</option>)}</select></label></div>
        <div className="row gap8"><label className="field grow"><span className="field-label">Seed</span><input className="input sm" inputMode="numeric" value={seed} onChange={e => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="random" /></label><label className="field grow"><span className="field-label">Steps</span><input className="input sm" inputMode="numeric" value={steps} onChange={e => setSteps(e.target.value.replace(/\D/g, ''))} placeholder="auto" /></label><label className="field grow"><span className="field-label">Guidance</span><input className="input sm" inputMode="decimal" value={guidance} onChange={e => setGuidance(e.target.value.replace(/[^\d.]/g, ''))} placeholder="auto" /></label></div>
      </div>}
      {busy ? <Button size="lg" onClick={() => void api.images.cancel()} icon={Square}>Stop</Button> : <Button size="lg" variant="primary" icon={mode === 'generate' ? Sparkles : Wand2} onClick={() => void generate()} disabled={!imageModels.length}>{mode === 'generate' ? 'Create' : mode === 'edit' ? 'Apply edit' : 'Make variations'}</Button>}
      {!imageModels.length && <div className="st-hint">Add an image provider (OpenAI, Google, Stability or a local Stable Diffusion server) in <button className="link-btn" onClick={() => useEditor.getState().openPage('models', undefined, 'Models & providers')}>Models</button>.</div>}
    </aside>
    <main className="st-main">
      <div className="st-stage">
        {busy && <div className="st-busy"><Loader2 size={20} className="spin-anim" />{busy}</div>}
        {!asset || !url ? <EmptyState icon={ImageIcon} title="Your canvas" text="Describe an image on the left and press Create. Or pick something from your library, or import a picture to edit."><Button icon={Upload} onClick={() => void importFiles()}>Import images</Button></EmptyState>
          : mode === 'edit' ? <MaskCanvas key={asset.id} url={url} brush={brush} onReady={a => { mask.current = a }} /> : <img className="st-img" src={url} alt={asset.name} draggable={false} />}
      </div>
      {asset && <div className="st-bar">
        <div className="st-meta"><b className="truncate">{asset.name}</b><span className="subtle small">{asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}{formatBytes(asset.size)} · {timeAgo(asset.createdAt)}{asset.model ? ` · ${asset.model.model}` : ''}</span></div>
        <IconButton icon={Heart} tip={asset.favorite ? 'Remove from favourites' : 'Favourite'} className={asset.favorite ? 'fav-on' : ''} onClick={async () => { await api.images.updateAsset(asset.id, { favorite: !asset.favorite }); reload() }} />
        <Button size="sm" icon={ZoomIn} onClick={() => void upscale(2)} disabled={!!busy} tip="Upscale ×2 with an image model (Stability AI)">×2</Button>
        <Button size="sm" variant="ghost" icon={Maximize2} onClick={() => void enlargeLocal()} disabled={!!busy} tip="Enlarge ×2 on this computer (smooth, no AI)">Quick ×2</Button>
        <Button size="sm" icon={Eye} onClick={() => void describe()} disabled={!!busy}>Describe</Button>
        <Button size="sm" icon={FileSearch} onClick={() => void ocr()} disabled={!!busy}>Read text</Button>
        <Button size="sm" icon={FolderInput} onClick={() => void saveProject()}>To project</Button>
        <IconButton icon={Download} tip="Save as…" onClick={() => void exportAsset()} /><IconButton icon={Trash2} tip="Delete" onClick={() => void remove()} />
      </div>}
      {asset?.prompt && <div className="st-prompt selectable"><span className="subtle small">Prompt</span> {asset.prompt}<IconButton icon={Copy} size="sm" tip="Copy prompt" onClick={() => void copyText(asset.prompt!)} /><button className="link-btn small" onClick={() => { setPrompt(asset.prompt!); setMode('generate') }}>Use again</button></div>}
      {text && <div className="st-text card"><div className="row"><b>{text.title}</b><span className="grow" /><IconButton icon={Copy} size="sm" tip="Copy" onClick={() => void copyText(text.body)} /><IconButton icon={X} size="sm" tip="Close" onClick={() => setText(null)} /></div><pre className="selectable">{text.body}</pre></div>}
      <div className="st-lib">
        <div className="st-lib-head"><b>Library</b><Badge>{assets.length}</Badge><span className="grow" /><Button size="sm" variant="ghost" icon={Upload} onClick={() => void importFiles()}>Import</Button></div>
        <div className="st-strip">{assets.map(a => <button key={a.id} className={cn('st-thumb', a.id === sel && 'on')} onClick={() => setSel(a.id)} data-tip={a.prompt || a.name}><Thumb id={a.id} alt={a.name} />{a.favorite && <Heart size={11} className="tg-fav" fill="currentColor" />}</button>)}{assets.length === 0 && <span className="subtle small" style={{ padding: 8 }}>Everything you create or import shows up here.</span>}</div>
      </div>
    </main>
  </div>
}

