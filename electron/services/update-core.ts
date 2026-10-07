import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { compareVersions, type UpdateInfo, type UpdateState } from '../../shared/update'

// The release manifest lives next to the installer in the repository. It is untrusted input: validate it, never
// "repair" it, and only ever download from https (plain http only for loopback, which the tests use).
const Manifest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  file: z.string().min(1).max(600),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  size: z.number().int().positive().max(600 * 1024 * 1024),
  notes: z.string().max(20_000).default(''),
  date: z.string().max(40).optional()
})

export interface UpdaterDeps {
  version: string
  fetch: typeof fetch
  /** where installers are downloaded to */
  dir: string
  manifestUrls(): string[]
  platform: NodeJS.Platform
  emit(state: UpdateState): void
  /** starts the installer (Windows) — the caller quits the app afterwards */
  launch(file: string): void
  /** shows the downloaded installer to the user (other platforms) */
  reveal(file: string): void
  log?(msg: string): void
}

const allowedUrl = (u: URL) => u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))

export class Updater {
  private st: UpdateState
  private abort: AbortController | null = null
  private job: Promise<UpdateState> | null = null
  private lastEmit = 0

  constructor(private d: UpdaterDeps) { this.st = { current: d.version, status: 'idle' } }

  state(): UpdateState { return this.st }
  private set(s: UpdateState, force = true): UpdateState {
    this.st = s
    const now = Date.now()
    if (force || now - this.lastEmit > 120) { this.lastEmit = now; this.d.emit(s) }
    return s
  }
  private file(info: UpdateInfo) { return join(this.d.dir, `TGGAGS-IDE-Setup-${info.version}.exe`) }

  /** Asks the repository for the newest release. `manual` shows progress and errors; background checks stay silent. */
  async check(manual = false): Promise<UpdateState> {
    if (this.st.status === 'downloading' || this.st.status === 'ready') return this.st
    if (manual) this.set({ current: this.d.version, status: 'checking' })
    let best: UpdateInfo | null = null
    let failure = ''
    for (const url of this.d.manifestUrls()) {
      try {
        const res = await this.d.fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'cache-control': 'no-cache', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
        if (!res.ok) { failure ||= `The update server answered ${res.status}.`; continue }
        const m = Manifest.parse(JSON.parse(await res.text()))
        const target = new URL(m.file, url)
        if (!allowedUrl(target)) { failure ||= 'The update points to an insecure address, so it was ignored.'; continue }
        if (!best || compareVersions(m.version, best.version) > 0) best = { version: m.version, notes: m.notes, size: m.size, sha256: m.sha256.toLowerCase(), url: target.toString(), date: m.date }
      } catch (e) { failure ||= (e as Error).name === 'TimeoutError' ? 'The update server did not answer in time.' : /fetch failed|ENOTFOUND|ECONN|net::/i.test((e as Error).message) ? 'Could not reach the update server. Check your internet connection.' : `The update information could not be read (${(e as Error).message.slice(0, 120)}).` }
    }
    if (best && compareVersions(best.version, this.d.version) > 0) return this.set({ current: this.d.version, status: 'available', info: best })
    if (!best && failure) {
      this.d.log?.(`update check failed: ${failure}`)
      if (manual) return this.set({ current: this.d.version, status: 'error', message: failure })
      return this.st.status === 'checking' ? this.set({ current: this.d.version, status: 'idle' }) : this.st
    }
    return this.set({ current: this.d.version, status: 'idle', checkedAt: Date.now() })
  }

  /** Downloads the installer and verifies size + SHA-256. Resolves with the final state (ready or error). */
  download(): Promise<UpdateState> {
    if (this.job) return this.job
    const info = 'info' in this.st ? this.st.info : undefined
    if (!info || this.st.status === 'idle' || this.st.status === 'checking') return Promise.resolve(this.st)
    if (this.st.status === 'ready') return Promise.resolve(this.st)
    this.job = this.run(info).finally(() => { this.job = null; this.abort = null })
    return this.job
  }

  private async run(info: UpdateInfo): Promise<UpdateState> {
    const cur = this.d.version
    const target = this.file(info), part = target + '.part'
    try {
      await mkdir(this.d.dir, { recursive: true })
      for (const f of await readdir(this.d.dir).catch(() => [] as string[])) if (/^TGGAGS-IDE-Setup-.*\.(exe|part)$/.test(f) && join(this.d.dir, f) !== target) await rm(join(this.d.dir, f), { force: true })
      if (await this.valid(target, info)) return this.set({ current: cur, status: 'ready', info })
      this.set({ current: cur, status: 'downloading', info, received: 0 })
      this.abort = new AbortController()
      const res = await this.d.fetch(info.url, { signal: this.abort.signal })
      if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}.`)
      const hash = createHash('sha256')
      let received = 0
      const out = createWriteStream(part)
      const body = Readable.fromWeb(res.body as never)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        hash.update(chunk)
        if (received > info.size) body.destroy(new Error('The download is larger than announced.'))
        else this.set({ current: cur, status: 'downloading', info, received }, false)
      })
      await new Promise<void>((resolve, reject) => { body.on('error', reject); out.on('error', reject); out.on('finish', resolve); body.pipe(out) })
      if (received !== info.size || hash.digest('hex') !== info.sha256) { await rm(part, { force: true }); throw new Error('The download is damaged (checksum mismatch). Please try again.') }
      await rename(part, target)
      return this.set({ current: cur, status: 'ready', info })
    } catch (e) {
      await rm(part, { force: true }).catch(() => undefined)
      if (this.abort?.signal.aborted) return this.set({ current: cur, status: 'available', info })
      const msg = (e as Error).message || 'The download failed.'
      this.d.log?.(`update download failed: ${msg}`)
      return this.set({ current: cur, status: 'error', message: /fetch failed|ECONN|ENOTFOUND|net::|terminated/i.test(msg) ? 'The download was interrupted. Check your internet connection and try again.' : msg, info })
    }
  }

  private async valid(file: string, info: UpdateInfo): Promise<boolean> {
    try {
      if ((await stat(file)).size !== info.size) return false
      const h = createHash('sha256')
      await new Promise<void>((res, rej) => { const r = createReadStream(file); r.on('data', c => h.update(c)); r.on('end', () => res()); r.on('error', rej) })
      return h.digest('hex') === info.sha256
    } catch { return false }
  }

  cancel(): void { this.abort?.abort() }

  /** Starts the installer in update mode (Windows) or shows the file. The caller quits the app when `launched`. */
  install(): 'launched' | 'revealed' {
    if (this.st.status !== 'ready') throw new Error('The update has not been downloaded yet.')
    const file = this.file(this.st.info)
    if (this.d.platform === 'win32') { this.d.launch(file); return 'launched' }
    this.d.reveal(file)
    return 'revealed'
  }
}
