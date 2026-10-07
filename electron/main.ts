import { startUpdateChecks } from './services/updater'
import { app, protocol, net, Menu, BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { settings } from './services/settings'
import { registerRpc } from './rpc'
import { buildApi } from './api'
import { createMainWindow, mainWindow } from './window'
import { workspace } from './services/workspace'
import { emit } from './services/events'
import { log } from './services/log'
import { bootAi } from './ai/boot'
import { sessions } from './ai/sessions'
import { terminals } from './dev/terminal'
import { lsp } from './dev/lsp'
import { killAllBackground } from './ai/tools/background'

if (process.env.TGG_USER_DATA) app.setPath('userData', process.env.TGG_USER_DATA)
app.setName('TGGAGS IDE')

protocol.registerSchemesAsPrivileged([
  { scheme: 'tgg-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

const e2e = !!process.env.TGG_E2E
if (!e2e && !app.requestSingleInstanceLock()) { app.quit() }

function cliPath(argv: string[]): string | null {
  for (const a of argv.slice(app.isPackaged ? 1 : 2)) {
    if (a.startsWith('-')) continue
    const p = resolve(a)
    if (!app.isPackaged && p === resolve(app.getAppPath())) continue // `electron .` – the app itself is not a project
    if (existsSync(p)) return p
  }
  return null
}

async function openCliPath(p: string): Promise<void> {
  const st = statSync(p)
  if (st.isDirectory()) { await workspace.open(p); return }
  emit('app:open-path', { path: p, isDir: false })
}

app.on('second-instance', (_e, argv) => {
  const w = mainWindow
  if (w) { if (w.isMinimized()) w.restore(); w.focus() }
  const p = cliPath(argv)
  if (p) void openCliPath(p)
})

app.whenReady().then(async () => {
  settings.init()
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  protocol.handle('tgg-file', req => {
    const url = new URL(req.url)
    const p = decodeURIComponent(url.pathname.replace(/^\//, ''))
    return net.fetch(pathToFileURL(p).toString())
  })

  bootAi()
  registerRpc(buildApi())
  const win = createMainWindow()
  startUpdateChecks()

  win.webContents.once('did-finish-load', async () => {
    const cli = cliPath(process.argv)
    const last = settings.get().ui.lastProject
    try {
      if (cli) await openCliPath(cli)
      else if (last && !process.env.TGG_NO_RESTORE && existsSync(last)) await workspace.open(last)
    } catch (e) { log.warn('main', `Could not restore workspace: ${(e as Error).message}`) }
  })

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
}).catch(err => { console.error('Fatal startup error', err); app.exit(1) })

app.on('before-quit', () => { settings.flush(); sessions.flushAll(); terminals.killAll(); lsp.shutdown(); killAllBackground() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
