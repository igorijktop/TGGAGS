import { promises as fsp, existsSync } from 'node:fs'
import { basename, extname, join, dirname, resolve } from 'node:path'
import type { AssetKind, AssetMeta, ImageApi, ImageRequest } from '../../shared/media'
import { mimeForPath } from '../../shared/languages'
import type { ProviderConfig } from '../../shared/settings'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { dataDir, dataPath } from '../services/paths'
import { readJson, writeJson, uid } from '../services/storage'
import { emit } from '../services/events'
import { credentials } from '../services/credentials'
import { errorFromResponse, httpFetch, joinUrl, makeAbort, networkError } from '../ai/providers/http'
import { ProviderError, resolveApiKey } from '../ai/providers'
import { runtime } from '../ai/runtime'

interface RawImage { mime: string; data: string }

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length > 10 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}
const extFor = (mime: string) => (mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png')

function sizeToAspect(size?: string, aspect?: string): string {
  if (aspect) return aspect
  const m = size?.match(/(\d+)x(\d+)/)
  if (!m) return '1:1'
  const w = Number(m[1]), h = Number(m[2])
  const r = w / h
  const opts: [string, number][] = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9]]
  return opts.sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0]
}

async function fetchBinary(url: string, signal: AbortSignal): Promise<RawImage> {
  const r = await httpFetch(url, { signal })
  if (!r.ok) throw new Error(`Could not download the generated image (HTTP ${r.status})`)
  return { mime: r.headers.get('content-type')?.split(';')[0] ?? 'image/png', data: Buffer.from(await r.arrayBuffer()).toString('base64') }
}

function blobOf(img: RawImage): Blob { return new Blob([Buffer.from(img.data, 'base64')], { type: img.mime }) }

// ───────────── provider adapters ─────────────
async function genOpenAI(cfg: ProviderConfig, key: string | undefined, req: ImageRequest, input: RawImage | null, mask: RawImage | null, signal: AbortSignal): Promise<{ images: RawImage[]; revised?: string }> {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) }
  if (key) headers.authorization = `Bearer ${key}`
  const isGptImage = /gpt-image/.test(req.model.model)
  let res: Response
  const url = joinUrl(cfg.baseUrl, input ? 'images/edits' : 'images/generations')
  try {
    if (input) {
      const fd = new FormData()
      fd.append('model', req.model.model); fd.append('prompt', req.prompt)
      fd.append('image', blobOf(input), `image.${extFor(input.mime)}`)
      if (mask) fd.append('mask', blobOf(mask), 'mask.png')
      if (req.n) fd.append('n', String(req.n))
      if (req.size && req.size !== 'auto') fd.append('size', req.size)
      res = await httpFetch(url, { method: 'POST', headers, body: fd, signal })
    } else {
      const body: Record<string, unknown> = { model: req.model.model, prompt: req.prompt, n: req.n ?? 1 }
      if (req.size && req.size !== 'auto') body.size = req.size
      if (isGptImage) { if (req.quality) body.quality = req.quality; if (req.format) body.output_format = req.format } else { body.response_format = 'b64_json'; if (req.quality === 'hd') body.quality = 'hd'; if (req.style) body.style = req.style }
      res = await httpFetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    }
  } catch (e) { throw networkError(e, cfg.name, url) }
  if (!res.ok) throw await errorFromResponse(res, cfg.name)
  const j = await res.json() as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[] }
  const images: RawImage[] = []
  for (const d of j.data ?? []) {
    if (d.b64_json) images.push({ mime: `image/${req.format ?? 'png'}`, data: d.b64_json })
    else if (d.url) images.push(await fetchBinary(d.url, signal))
  }
  return { images, revised: j.data?.[0]?.revised_prompt }
}

async function genGoogle(cfg: ProviderConfig, key: string | undefined, req: ImageRequest, input: RawImage | null, signal: AbortSignal): Promise<{ images: RawImage[] }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(cfg.headers ?? {}) }
  if (key) headers['x-goog-api-key'] = key
  const model = req.model.model.replace(/^models\//, '')
  if (/imagen/.test(model)) {
    const url = joinUrl(cfg.baseUrl, `models/${model}:predict`)
    let res: Response
    try { res = await httpFetch(url, { method: 'POST', headers, signal, body: JSON.stringify({ instances: [{ prompt: req.prompt }], parameters: { sampleCount: req.n ?? 1, aspectRatio: sizeToAspect(req.size, req.aspectRatio) } }) }) } catch (e) { throw networkError(e, cfg.name, url) }
    if (!res.ok) throw await errorFromResponse(res, cfg.name)
    const j = await res.json() as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] }
    return { images: (j.predictions ?? []).filter(p => p.bytesBase64Encoded).map(p => ({ mime: p.mimeType ?? 'image/png', data: p.bytesBase64Encoded! })) }
  }
  const url = joinUrl(cfg.baseUrl, `models/${model}:generateContent`)
  const parts: unknown[] = [{ text: req.prompt }]
  if (input) parts.push({ inlineData: { mimeType: input.mime, data: input.data } })
  let res: Response
  try { res = await httpFetch(url, { method: 'POST', headers, signal, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) }) } catch (e) { throw networkError(e, cfg.name, url) }
  if (!res.ok) throw await errorFromResponse(res, cfg.name)
  const j = await res.json() as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[] } }[] }
  const images = (j.candidates?.[0]?.content?.parts ?? []).filter(p => p.inlineData).map(p => ({ mime: p.inlineData!.mimeType, data: p.inlineData!.data }))
  if (!images.length) throw new ProviderError(`${cfg.name}: the model returned no image. ${j.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.slice(0, 200) ?? ''}`, 'other')
  return { images }
}

async function genStability(cfg: ProviderConfig, key: string | undefined, req: ImageRequest, input: RawImage | null, mask: RawImage | null, signal: AbortSignal): Promise<{ images: RawImage[] }> {
  const fd = new FormData()
  fd.append('prompt', req.prompt)
  if (req.negativePrompt) fd.append('negative_prompt', req.negativePrompt)
  fd.append('output_format', req.format === 'jpeg' ? 'jpeg' : req.format === 'webp' ? 'webp' : 'png')
  if (req.seed !== undefined) fd.append('seed', String(req.seed))
  let path = `v2beta/stable-image/generate/${req.model.model === 'ultra' ? 'ultra' : req.model.model.startsWith('sd3') ? 'sd3' : 'core'}`
  if (req.model.model.startsWith('sd3')) fd.append('model', req.model.model)
  if (input) {
    fd.append('image', blobOf(input), 'image.png')
    if (mask) { path = 'v2beta/stable-image/edit/inpaint'; fd.append('mask', blobOf(mask), 'mask.png') }
    else { path = 'v2beta/stable-image/generate/sd3'; fd.append('mode', 'image-to-image'); fd.append('strength', String(req.strength ?? 0.6)); fd.append('model', req.model.model.startsWith('sd3') ? req.model.model : 'sd3.5-large') }
  } else fd.append('aspect_ratio', sizeToAspect(req.size, req.aspectRatio))
  const url = joinUrl(cfg.baseUrl, path)
  const out: RawImage[] = []
  for (let i = 0; i < Math.min(req.n ?? 1, 4); i++) {
    let res: Response
    try { res = await httpFetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'image/*', ...(cfg.headers ?? {}) }, body: fd, signal }) } catch (e) { throw networkError(e, cfg.name, url) }
    if (!res.ok) throw await errorFromResponse(res, cfg.name)
    out.push({ mime: res.headers.get('content-type')?.split(';')[0] ?? 'image/png', data: Buffer.from(await res.arrayBuffer()).toString('base64') })
    if (req.seed !== undefined) fd.set('seed', String(req.seed + i + 1))
  }
  return { images: out }
}

async function genA1111(cfg: ProviderConfig, req: ImageRequest, input: RawImage | null, mask: RawImage | null, signal: AbortSignal): Promise<{ images: RawImage[] }> {
  const m = req.size?.match(/(\d+)x(\d+)/)
  const body: Record<string, unknown> = {
    prompt: req.prompt, negative_prompt: req.negativePrompt ?? '', steps: req.steps ?? 25, cfg_scale: req.guidance ?? 7, seed: req.seed ?? -1, batch_size: req.n ?? 1,
    width: m ? Number(m[1]) : 512, height: m ? Number(m[2]) : 512
  }
  if (req.model.model !== 'default') body.override_settings = { sd_model_checkpoint: req.model.model }
  if (input) { body.init_images = [input.data]; body.denoising_strength = req.strength ?? 0.6; if (mask) body.mask = mask.data }
  const url = joinUrl(cfg.baseUrl, input ? 'sdapi/v1/img2img' : 'sdapi/v1/txt2img')
  let res: Response
  try { res = await httpFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) }, body: JSON.stringify(body), signal }) } catch (e) { throw networkError(e, cfg.name, url) }
  if (!res.ok) throw await errorFromResponse(res, cfg.name)
  const j = await res.json() as { images?: string[] }
  return { images: (j.images ?? []).map(data => ({ mime: 'image/png', data })) }
}

// ───────────── asset library ─────────────
class AssetStore {
  private assets: AssetMeta[] | null = null
  private dir() { return dataDir('assets') }
  private index() { return join(this.dir(), 'index.json') }
  async all(): Promise<AssetMeta[]> {
    if (!this.assets) this.assets = await readJson<AssetMeta[]>(this.index(), [])
    return this.assets
  }
  private async save() { await writeJson(this.index(), this.assets ?? []) }
  async add(img: RawImage, meta: Partial<AssetMeta> & { name: string; kind: AssetKind }): Promise<AssetMeta> {
    const all = await this.all()
    const id = uid('a-')
    const file = `${id}.${extFor(img.mime)}`
    const buf = Buffer.from(img.data, 'base64')
    await fsp.writeFile(join(this.dir(), file), buf)
    const dim = pngSize(buf)
    const a: AssetMeta = { id, file, mime: img.mime, size: buf.length, width: dim?.width, height: dim?.height, tags: [], favorite: false, createdAt: Date.now(), ...meta }
    all.unshift(a)
    await this.save()
    emit('assets:changed', undefined)
    return a
  }
  async get(id: string) { return (await this.all()).find(a => a.id === id) ?? null }
  pathOf(a: AssetMeta) { return join(this.dir(), a.file) }
  async read(a: AssetMeta): Promise<RawImage> { return { mime: a.mime, data: (await fsp.readFile(this.pathOf(a))).toString('base64') } }
  async update(id: string, patch: Partial<AssetMeta>) { const a = await this.get(id); if (!a) return null; Object.assign(a, patch); await this.save(); emit('assets:changed', undefined); return a }
  async remove(id: string) { const a = await this.get(id); if (!a) return; await fsp.rm(this.pathOf(a), { force: true }); this.assets = (await this.all()).filter(x => x.id !== id); await this.save(); emit('assets:changed', undefined) }
}
export const assets = new AssetStore()

let current: AbortController | null = null

function providerFor(ref: { provider: string }): { cfg: ProviderConfig; key: string | undefined } {
  const cfg = settings.get().providers.find(p => p.id === ref.provider)
  if (!cfg) throw new Error('Select an image model first (Settings → Models, add an image-capable provider such as OpenAI, Gemini, Stability or a local Stable Diffusion server).')
  const key = resolveApiKey(cfg)
  if (cfg.requiresKey && !key) throw new Error(`${cfg.name} needs an API key (Settings → Models).`)
  return { cfg, key }
}

export async function generateImages(req: ImageRequest, signal?: AbortSignal): Promise<AssetMeta[]> {
  const { cfg, key } = providerFor(req.model)
  const ab = makeAbort(signal ?? current?.signal, 300_000)
  try {
    let input: RawImage | null = req.inputImage ?? null
    let parent: AssetMeta | null = null
    if (!input && req.inputAssetId) { parent = await assets.get(req.inputAssetId); if (parent) input = await assets.read(parent) }
    if (req.mode !== 'generate' && !input) throw new Error('Choose an image to edit.')
    const mask = req.maskImage ?? null
    let out: { images: RawImage[]; revised?: string }
    switch (cfg.protocol) {
      case 'openai': out = await genOpenAI(cfg, key, req, req.mode === 'generate' ? null : input, mask, ab.signal); break
      case 'google': out = await genGoogle(cfg, key, req, req.mode === 'generate' ? null : input, ab.signal); break
      case 'stability': out = await genStability(cfg, key, req, req.mode === 'generate' ? null : input, mask, ab.signal); break
      case 'a1111': out = await genA1111(cfg, req, req.mode === 'generate' ? null : input, mask, ab.signal); break
      default: throw new Error(`${cfg.name} cannot generate images.`)
    }
    if (!out.images.length) throw new Error('The provider returned no images.')
    const saved: AssetMeta[] = []
    for (const img of out.images) {
      saved.push(await assets.add(img, {
        name: req.prompt.slice(0, 50) || 'image', kind: req.mode === 'generate' ? 'generated' : 'edited', prompt: out.revised ?? req.prompt, negativePrompt: req.negativePrompt, model: req.model,
        params: { size: req.size, seed: req.seed, steps: req.steps, guidance: req.guidance, quality: req.quality, mode: req.mode }, parentId: parent?.id
      }))
    }
    return saved
  } finally { ab.done() }
}

async function upscaleViaProvider(a: AssetMeta, scale: number, ref: { provider: string; model: string } | undefined, signal: AbortSignal): Promise<RawImage> {
  if (!ref) throw new Error('No provider selected for upscaling.')
  const { cfg, key } = providerFor(ref)
  const img = await assets.read(a)
  if (cfg.protocol === 'a1111') {
    const res = await httpFetch(joinUrl(cfg.baseUrl, 'sdapi/v1/extra-single-image'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: img.data, upscaling_resize: scale, upscaler_1: 'R-ESRGAN 4x+' }), signal })
    if (!res.ok) throw await errorFromResponse(res, cfg.name)
    return { mime: 'image/png', data: ((await res.json()) as { image: string }).image }
  }
  if (cfg.protocol === 'stability') {
    const fd = new FormData(); fd.append('image', blobOf(img), 'image.png'); fd.append('output_format', 'png')
    const res = await httpFetch(joinUrl(cfg.baseUrl, 'v2beta/stable-image/upscale/fast'), { method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'image/*' }, body: fd, signal })
    if (!res.ok) throw await errorFromResponse(res, cfg.name)
    return { mime: 'image/png', data: Buffer.from(await res.arrayBuffer()).toString('base64') }
  }
  throw new Error(`${cfg.name} does not offer upscaling. Use the built-in upscaler instead.`)
}

export const imageApi: ImageApi = {
  async generate(req) {
    current?.abort()
    current = new AbortController()
    try { return await generateImages(req, current.signal) } finally { current = null }
  },
  async cancel() { current?.abort() },
  async upscale(assetId, scale, model) {
    const a = await assets.get(assetId)
    if (!a) throw new Error('Asset not found')
    const ac = new AbortController()
    const img = await upscaleViaProvider(a, scale, model, ac.signal)
    return assets.add(img, { name: `${a.name} ×${scale}`, kind: 'upscaled', parentId: a.id, prompt: a.prompt, model })
  },
  async describe(assetId, prompt) {
    const a = await assets.get(assetId)
    if (!a) throw new Error('Asset not found')
    const cand = await runtime.helperModel(settings.get().ai.defaultModel)
    if (!cand) throw new Error('Add a vision-capable chat model in Settings → Models first.')
    const img = await assets.read(a)
    return runtime.oneShot(cand, 'You are a precise visual analyst. Describe images accurately and concisely.', prompt ?? 'Describe this image in detail: subject, composition, colours, style, and any text.', undefined, { images: [img], maxTokens: 1200 })
  },
  async ocr(assetId) {
    const a = await assets.get(assetId)
    if (!a) throw new Error('Asset not found')
    const cand = await runtime.helperModel(settings.get().ai.defaultModel)
    if (!cand) throw new Error('Add a vision-capable chat model in Settings → Models first.')
    const img = await assets.read(a)
    return runtime.oneShot(cand, 'You are an OCR engine. Transcribe all text visible in the image exactly as written, preserving line breaks and reading order. Output only the transcribed text. If there is no text, output an empty response.', 'Transcribe the text in this image.', undefined, { images: [img], maxTokens: 4000 })
  },
  listAssets: () => assets.all(),
  async importFiles(paths) {
    const out: AssetMeta[] = []
    for (const p of paths) {
      const mime = mimeForPath(p)
      if (!mime.startsWith('image/')) continue
      out.push(await assets.add({ mime, data: (await fsp.readFile(p)).toString('base64') }, { name: basename(p, extname(p)), kind: 'imported' }))
    }
    return out
  },
  async importData(name, mime, base64, kind = 'imported', parentId, prompt) { return assets.add({ mime, data: base64 }, { name, kind, parentId, prompt }) },
  updateAsset: (id, patch) => assets.update(id, patch),
  deleteAsset: id => assets.remove(id),
  async exportAsset(id, dest) { const a = await assets.get(id); if (!a) throw new Error('Asset not found'); await fsp.copyFile(assets.pathOf(a), dest) },
  async saveToProject(id, rel) {
    const a = await assets.get(id)
    if (!a) throw new Error('Asset not found')
    const root = workspace.requireRoot()
    const dest = resolve(root, rel || `assets/${a.file}`)
    if (!dest.startsWith(resolve(root))) throw new Error('Choose a path inside the project')
    await fsp.mkdir(dirname(dest), { recursive: true })
    await fsp.copyFile(assets.pathOf(a), dest)
    return dest
  },
  async assetPath(id) { const a = await assets.get(id); return a ? assets.pathOf(a) : '' },
  async a1111Models(providerId) {
    const cfg = settings.get().providers.find(p => p.id === providerId)
    if (!cfg) return []
    try {
      const res = await httpFetch(joinUrl(cfg.baseUrl, 'sdapi/v1/sd-models'))
      return ((await res.json()) as { title: string }[]).map(m => m.title)
    } catch { return [] }
  }
}
void existsSync; void dataPath; void credentials
