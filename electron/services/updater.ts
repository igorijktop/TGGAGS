import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { emit } from './events'
import { log } from './log'
import { settings } from './settings'
import { httpFetch } from '../ai/providers/http'
import { Updater } from './update-core'

const REPO = 'igorijktop/TGGAGS'
// The release manifest is committed next to the installer. Every candidate is asked and the newest version wins, so the
// check keeps working when the work moves from the development branch to `main`.
const DEFAULT_MANIFESTS = [
  `https://raw.githubusercontent.com/${REPO}/main/release/latest.json`,
  `https://raw.githubusercontent.com/${REPO}/claude/relaxed-cannon-95tywy/release/latest.json`
]

export const updater = new Updater({
  version: app.getVersion(),
  fetch: (i, init) => httpFetch(i, init),
  dir: join(app.getPath('temp'), 'TGGAGS-IDE-update'),
  manifestUrls: () => {
    const env = process.env.TGG_UPDATE_MANIFEST, custom = settings.get().updates?.manifestUrl?.trim()
    return env ? [env] : custom ? [custom] : DEFAULT_MANIFESTS
  },
  platform: process.platform,
  emit: s => emit('update:state', s),
  // /UPDATE: the installer shows only a progress bar, keeps the install folder and the extras the user chose, and starts the app again
  launch: file => { spawn(file, ['/UPDATE'], { detached: true, stdio: 'ignore' }).unref() },
  reveal: file => shell.showItemInFolder(file),
  log: m => log.warn('updates', m)
})

/** Background checks: shortly after start and every few hours (only in the installed app, or when a test points at a manifest). */
export function startUpdateChecks(): void {
  if (!app.isPackaged && !process.env.TGG_UPDATE_MANIFEST) return
  const run = () => { if (settings.get().updates?.autoCheck !== false) void updater.check(false).catch(() => undefined) }
  setTimeout(run, process.env.TGG_UPDATE_MANIFEST ? 1500 : 20_000)
  setInterval(run, 4 * 60 * 60 * 1000).unref()
}
