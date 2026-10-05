import { BrowserWindow, screen, shell, app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { settings } from './services/settings'
import { themeById } from '../shared/themes'
import { dataPath } from './services/paths'
import { readJsonSync, writeJsonSync } from './services/storage'
import { emit } from './services/events'

export let mainWindow: BrowserWindow | null = null

interface WinState { x?: number; y?: number; width: number; height: number; maximized: boolean }

export function appIconPath(): string | undefined {
  // the packaged build ships a loose copy next to app.asar (native image loading cannot read inside an asar)
  const candidates = [join(process.resourcesPath ?? '', 'icon.png'), join(app.getAppPath(), 'resources', 'icon.png'), join(__dirname, '..', 'resources', 'icon.png')]
  return candidates.find(existsSync)
}

export function createMainWindow(): BrowserWindow {
  const stateFile = dataPath('window-state.json')
  const st = readJsonSync<WinState>(stateFile, { width: 1480, height: 920, maximized: false })
  const display = screen.getPrimaryDisplay().workArea
  const width = Math.min(st.width, display.width), height = Math.min(st.height, display.height)
  const theme = themeById(settings.get().appearance.theme)
  const bg = theme.ui['--bg-sidebar']
  const fg = theme.ui['--fg']
  const native = process.platform === 'win32' || process.platform === 'darwin'

  const win = new BrowserWindow({
    x: st.x, y: st.y, width, height, minWidth: 980, minHeight: 620,
    backgroundColor: bg, show: false, title: 'TGGAGS IDE', icon: appIconPath(), autoHideMenuBar: true,
    ...(native ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: bg, symbolColor: fg, height: 40 } } : { frame: false }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webviewTag: false
    }
  })
  mainWindow = win
  if (st.maximized) win.maximize()
  win.once('ready-to-show', () => { if (!process.env.TGG_HIDDEN) win.show() })

  const saveState = () => {
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    writeJsonSync(stateFile, { ...b, maximized: win.isMaximized() })
  }
  win.on('close', saveState)
  win.on('maximize', () => emit('window:maximized', true))
  win.on('unmaximize', () => emit('window:maximized', false))
  win.on('closed', () => { mainWindow = null })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url) }
  })
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { win.webContents.toggleDevTools(); e.preventDefault() }
  })

  const dev = process.env.VITE_DEV_SERVER_URL
  if (dev) void win.loadURL(dev)
  else void win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  return win
}
