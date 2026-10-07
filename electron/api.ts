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
import { updater } from './services/updater'
import { themeById } from '../shared/themes'
import { terminals } from './dev/terminal'
import { gitApi } from './dev/git'
import { lsp } from './dev/lsp'
import { debuggerService } from './dev/debug'
import { projectApi } from './dev/project'
import { mcp } from './ext/mcp'
import { extensions } from './ext/extensions'
import { imageApi } from './media/images'
import { benchApi } from './ai/bench'
import { githubApi } from './integrations/github'
import { aiApi, agentsApi, toolsApi, skillsApi, commandsApi, memoryApi, permissionsApi, providersApi } from './ai/api'

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
    updates: {
      async state() { return updater.state() },
      async check(manual) { return updater.check(!!manual) },
      async download() { return updater.download() },
      async cancel() { updater.cancel() },
      async install() {
        const r = updater.install()
        // give the installer a moment to start, then quit gracefully (settings and chats are flushed on quit) — it waits for the app to let go of its files
        if (r === 'launched') { setTimeout(() => app.quit(), 400); setTimeout(() => app.exit(0), 6000).unref() }
        return r
      }
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
      async reset(section) { return settings.reset(section as never) },
      async setSection(section, value) { return settings.setSection(section as never, value as never) }
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
    },
    ai: aiApi,
    agents: agentsApi,
    tools: toolsApi,
    skills: skillsApi,
    commands: commandsApi,
    memory: memoryApi,
    permissions: permissionsApi,
    providers: providersApi,
    terminal: {
      async create(o) { return terminals.create(o) },
      async write(id, d) { terminals.write(id, d) },
      async resize(id, c, r) { terminals.resize(id, c, r) },
      async kill(id) { terminals.kill(id) },
      async list() { return terminals.list() },
      async buffer(id) { return terminals.buffer(id) },
      async tail(chars, id) { return terminals.tail(chars, id) }
    },
    git: gitApi,
    lsp,
    debug: debuggerService,
    project: projectApi,
    mcp,
    extensions,
    images: imageApi,
    bench: benchApi,
    github: githubApi
  }
}
