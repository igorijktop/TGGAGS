import { basename, join, sep } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { settings } from './settings'
import { emit, bus } from './events'
import { fileIndex } from './fileindex'
import { log } from './log'

export interface FsChange { type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }
export interface WorkspaceInfo { root: string | null; name: string; isGit: boolean }

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', '.next', '.cache', 'dist-electron', '.turbo'])

class WorkspaceService {
  root: string | null = null
  private watcher: FSWatcher | null = null
  private gitWatcher: FSWatcher | null = null
  private queue: FsChange[] = []
  private timer: NodeJS.Timeout | null = null

  info(): WorkspaceInfo {
    return { root: this.root, name: this.root ? basename(this.root) : '', isGit: !!this.root && existsSync(join(this.root, '.git')) }
  }

  async open(root: string): Promise<WorkspaceInfo> {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`)
    await this.close(false)
    this.root = root
    const s = settings.get()
    const recent = [root, ...s.ui.recentProjects.filter(p => p !== root)].slice(0, 15)
    settings.update({ ui: { recentProjects: recent, lastProject: root } })
    this.startWatching(root)
    log.info('workspace', `Opened ${root}`)
    emit('workspace:changed', this.info())
    return this.info()
  }

  async close(notify = true): Promise<void> {
    await this.watcher?.close().catch(() => undefined)
    await this.gitWatcher?.close().catch(() => undefined)
    this.watcher = this.gitWatcher = null
    this.root = null
    settings.update({ ui: { lastProject: null } })
    if (notify) emit('workspace:changed', this.info())
  }

  private startWatching(root: string): void {
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => {
        const rel = p.length > root.length ? p.slice(root.length + 1) : ''
        return rel.split(sep).some(seg => IGNORED_SEGMENTS.has(seg))
      }
    })
    const push = (type: FsChange['type']) => (path: string) => {
      this.queue.push({ type, path })
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 180)
    }
    this.watcher.on('add', push('add')).on('change', push('change')).on('unlink', push('unlink'))
      .on('addDir', push('addDir')).on('unlinkDir', push('unlinkDir'))
      .on('error', (e) => log.warn('workspace', `watcher: ${e}`))

    const gitDir = join(root, '.git')
    if (existsSync(gitDir)) {
      this.gitWatcher = chokidar.watch([join(gitDir, 'HEAD'), join(gitDir, 'index'), join(gitDir, 'refs')], { ignoreInitial: true, persistent: true })
      let gt: NodeJS.Timeout | null = null
      const g = () => { if (gt) clearTimeout(gt); gt = setTimeout(() => { gt = null; emit('git:changed', { root }) }, 250) }
      this.gitWatcher.on('all', g).on('error', () => undefined)
    }
  }

  private flush(): void {
    this.timer = null
    const events = this.queue.splice(0)
    if (!events.length || !this.root) return
    fileIndex.invalidate(this.root)
    emit('fs:changed', { root: this.root, events })
    bus.emit('fs:changed:internal', events)
  }

  requireRoot(): string {
    if (!this.root) throw new Error('No project folder is open. Open a folder first.')
    return this.root
  }
}

export const workspace = new WorkspaceService()
