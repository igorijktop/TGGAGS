import { app, BrowserWindow } from 'electron'
import { shell } from 'electron'
import type { Api } from '../shared/api'
import { settings } from './services/settings'
import { credentials } from './services/credentials'
import { workspace } from './services/workspace'
import { fsApi } from './services/fsapi'
import { searchApi } from './services/search'
import { log } from './services/log'
import { dataPath, userDir } from './services/paths'
import { defaultShell } from './services/proc'
import { mainWindow } from './window'
import { themeById } from '../shared/themes'

const win = (): BrowserWindow => {
  const w = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!w) throw new Error('No window')
  return w
}

export function buildApi(): Api {
  return {
    app: {
      async info() {
        return {
          name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
          platform: process.platform, arch: process.arch, userData: userDir(), secureStorage: credentials.secure(), packaged: app.isPackaged,
          home: process.env.USERPROFILE || process.env.HOME || '', shellName: defaultShell(settings.get().terminal.shell).name, pid: process.pid
        }
      },
      async relaunch() { app.relaunch(); app.exit(0) },
      async quit() { app.quit() },
      async openUserData() { await shell.openPath(userDir()) },
      async openLogs() { await shell.openPath(dataPath('logs')) }
    },
    window: {
      async minimize() { win().minimize() },
      async toggleMaximize() { const w = win(); if (w.isMaximized()) w.unmaximize(); else w.maximize(); return w.isMaximized() },
      async close() { win().close() },
      async isMaximized() { return win().isMaximized() },
      async setTitleBarColors(bg, fg) {
        const w = win()
        w.setBackgroundColor(bg)
        if (process.platform === 'win32' || process.platform === 'darwin') { try { w.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 }) } catch { /* not supported */ } }
      },
      async reload() { win().webContents.reload() },
      async toggleDevTools() { win().webContents.toggleDevTools() },
      async setZoom(f) { win().webContents.setZoomFactor(Math.min(2, Math.max(0.6, f))) },
      async setFullScreen(on) { win().setFullScreen(on) }
    },
    settings: {
      async get() { return settings.get() },
      async update(patch) {
        const next = settings.update(patch as never)
        const t = themeById(next.appearance.theme)
        void t
        return next
      },
      async reset(section) { return settings.reset(section as never) }
    },
    credentials: {
      async set(key, value) { credentials.set(key, value) },
      async has(key) { return credentials.has(key) },
      async delete(key) { credentials.delete(key) },
      async secure() { return credentials.secure() }
    },
    workspace: {
      async info() { return workspace.info() },
      async open(root) { return workspace.open(root) },
      async close() { await workspace.close() }
    },
    fs: fsApi,
    search: searchApi,
    output: {
      async channels() { return log.channels() },
      async get(c) { return log.get(c) },
      async clear(c) { log.clear(c) }
    }
  }
}
