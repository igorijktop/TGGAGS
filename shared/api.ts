// The typed RPC surface between renderer and main process. Each domain is implemented in
// `electron/api.ts`; the renderer calls it through the proxy in `src/lib/api.ts`.
import type { Settings } from './settings'
import type { FileEntry, ReadFileResult, SearchOptions, SearchResult } from './fs'

export interface AppInfo {
  name: string; version: string; electron: string; chrome: string; node: string; platform: string; arch: string
  userData: string; secureStorage: boolean; packaged: boolean; home: string; shellName: string; pid: number
}

export interface WorkspaceInfo { root: string | null; name: string; isGit: boolean }
export interface FsChange { type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }
export interface LogLine { ts: number; channel: string; level: 'info' | 'warn' | 'error' | 'debug'; text: string }

export interface AppApi {
  info(): Promise<AppInfo>
  relaunch(): Promise<void>
  quit(): Promise<void>
  openUserData(): Promise<void>
  openLogs(): Promise<void>
}

export interface WindowApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  setTitleBarColors(bg: string, fg: string): Promise<void>
  reload(): Promise<void>
  toggleDevTools(): Promise<void>
  setZoom(factor: number): Promise<void>
  setFullScreen(on: boolean): Promise<void>
}

export interface SettingsApi {
  get(): Promise<Settings>
  update(patch: Record<string, unknown>): Promise<Settings>
  reset(section?: string): Promise<Settings>
}

export interface CredentialsApi {
  set(key: string, value: string): Promise<void>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  secure(): Promise<boolean>
}

export interface WorkspaceApi {
  info(): Promise<WorkspaceInfo>
  open(root: string): Promise<WorkspaceInfo>
  close(): Promise<void>
}

export interface FsApi {
  readDir(path: string): Promise<FileEntry[]>
  readFile(path: string): Promise<ReadFileResult>
  readFileBase64(path: string): Promise<{ base64: string; mime: string }>
  writeFile(path: string, content: string, encoding?: string): Promise<{ mtime: number; size: number }>
  writeBase64(path: string, base64: string): Promise<void>
  stat(path: string): Promise<{ exists: boolean; isDir: boolean; size: number; mtime: number }>
  createFile(path: string, content?: string): Promise<string>
  createDir(path: string): Promise<string>
  rename(from: string, to: string): Promise<string>
  delete(path: string, permanent?: boolean): Promise<void>
  duplicate(path: string): Promise<string>
  copyTo(src: string, destDir: string): Promise<string>
  move(src: string, destDir: string): Promise<string>
  reveal(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  pickFolder(title?: string): Promise<string | null>
  pickFiles(title?: string, filters?: { name: string; extensions: string[] }[], multi?: boolean): Promise<string[]>
  pickSavePath(title: string, defaultPath?: string): Promise<string | null>
  listFiles(): Promise<string[]>
  home(): Promise<string>
}

export interface SearchApi {
  search(o: SearchOptions, searchId?: string): Promise<SearchResult>
  cancel(id: string): Promise<void>
  replace(o: SearchOptions, replacement: string, files?: string[]): Promise<{ files: number; replacements: number }>
  replaceOne(path: string, line: number, col: number, length: number, expected: string, replacement: string): Promise<boolean>
}

export interface OutputApi {
  channels(): Promise<string[]>
  get(channel: string): Promise<LogLine[]>
  clear(channel: string): Promise<void>
}

export interface Api {
  app: AppApi
  window: WindowApi
  settings: SettingsApi
  credentials: CredentialsApi
  workspace: WorkspaceApi
  fs: FsApi
  search: SearchApi
  output: OutputApi
}

export interface EventMap {
  'settings:changed': Settings
  'workspace:changed': WorkspaceInfo
  'fs:changed': { root: string; events: FsChange[] }
  'git:changed': { root: string }
  'output:line': LogLine
  'output:cleared': string
  'window:maximized': boolean
  'app:open-path': { path: string; isDir: boolean }
}
