// The typed RPC surface between renderer and main process. Each domain is implemented in
// `electron/api.ts`; the renderer calls it through the proxy in `src/lib/api.ts`.
import type { McpApi, ExtensionsApi } from './ext'
import type { ImageApi, BenchApi, GithubApi, AssetMeta, BenchProgress } from './media'
import type { BenchResult } from './ai'
import type { TerminalCreateOptions, TerminalInfo, GitApi, LspApi, DebugApi, ProjectApi, LspDiagnostic, LspServerStatus, DebugSnapshot, Breakpoint } from './dev'
import type { Settings, AgentConfig, ModelInfo, PermissionRule, ProviderConfig } from './settings'
import type {
  AiEvent, CommandInfo, ContextItem, ContextSnapshot, FileChange, MemoryState, PermissionReply, PermissionRequest, QuestionReply, QuestionRequest,
  SendRequest, Session, SessionMeta, SkillInfo, ToolInfo, UsageStats
} from './ai'
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

export interface TerminalApi {
  create(opts?: TerminalCreateOptions): Promise<TerminalInfo>
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  kill(id: string): Promise<void>
  list(): Promise<TerminalInfo[]>
  buffer(id: string): Promise<string>
  tail(chars?: number, id?: string): Promise<string>
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
  ai: AiApi
  agents: AgentsApi
  tools: ToolsApi
  skills: SkillsApi
  commands: CommandsApi
  memory: MemoryApi
  permissions: PermissionsApi
  providers: ProvidersApi
  terminal: TerminalApi
  git: GitApi
  lsp: LspApi
  debug: DebugApi
  project: ProjectApi
  mcp: McpApi
  extensions: ExtensionsApi
  images: ImageApi
  bench: BenchApi
  github: GithubApi
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
  'ai:event': AiEvent
  'terminal:data': { id: string; data: string }
  'terminal:exit': { id: string; code: number | null }
  'terminal:created': TerminalInfo
  'terminal:removed': { id: string }
  'lsp:diagnostics': { path: string; diagnostics: LspDiagnostic[] }
  'lsp:status': LspServerStatus[] | undefined
  'debug:state': DebugSnapshot
  'debug:output': { category: 'stdout' | 'stderr' | 'info' | 'error'; text: string }
  'debug:breakpoints': { path: string; breakpoints: Breakpoint[] }
  'mcp:changed': import('./ext').McpServerState[]
  'ext:changed': undefined
  'app:notify': { message: string; level: 'info' | 'warn' | 'error'; source?: string }
  'assets:changed': undefined
  'bench:progress': BenchProgress
  'bench:result': BenchResult
}
export type { AssetMeta }

// ───────────────────────── AI engine ─────────────────────────

export interface AiSessionsApi {
  list(projectOnly?: boolean): Promise<SessionMeta[]>
  get(id: string): Promise<Session | null>
  create(opts?: { agent?: string }): Promise<Session>
  delete(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  fork(id: string, messageId?: string): Promise<Session | null>
  exportMarkdown(id: string): Promise<string>
  setConfig(id: string, cfg: { agent?: string; model?: import('./settings').ModelRef | null; mode?: import('./settings').PermissionMode; reasoning?: import('./settings').ReasoningEffort }): Promise<void>
  stats(): Promise<UsageStats>
  /** delete a message and everything after it (edit & resend) */
  truncateAt(id: string, messageId: string): Promise<Session | null>
}

export interface AiChangesApi {
  list(sessionId: string): Promise<FileChange[]>
  undoFromTurn(sessionId: string, turnId: string | null): Promise<{ reverted: number; files: string[] }>
  undoLastTurn(sessionId: string): Promise<{ reverted: number; files: string[] }>
  redo(sessionId: string): Promise<{ applied: number; files: string[] }>
  revertFile(sessionId: string, path: string): Promise<boolean>
  accept(sessionId: string): Promise<void>
  canRedo(sessionId: string): Promise<boolean>
}

export interface AiContextApi {
  get(sessionId: string): Promise<ContextSnapshot | null>
  setItems(sessionId: string, items: ContextItem[]): Promise<ContextSnapshot | null>
  /** resolve a file/folder into a context item with an estimated token count */
  describe(path: string): Promise<ContextItem>
  estimate(text: string): Promise<number>
}

export interface AiApi {
  send(req: SendRequest): Promise<{ sessionId: string }>
  abort(sessionId: string): Promise<void>
  running(): Promise<string[]>
  pending(): Promise<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }>
  answerPermission(r: PermissionReply): Promise<void>
  answerQuestion(r: QuestionReply): Promise<void>
  compact(sessionId: string): Promise<boolean>
  sessions: AiSessionsApi
  changes: AiChangesApi
  context: AiContextApi
  /** one-off completion with the helper model (commit messages, PR text …) */
  complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
}

export interface AgentsApi {
  list(): Promise<AgentConfig[]>
  save(agent: AgentConfig): Promise<void>
  remove(id: string): Promise<void>
  writeFile(agent: AgentConfig, scope: 'project' | 'global'): Promise<string>
}

export interface ToolsApi { list(): Promise<ToolInfo[]> }
export interface SkillsApi {
  list(): Promise<SkillInfo[]>
  read(name: string): Promise<string>
  create(name: string, description: string, body: string, scope: 'project' | 'global'): Promise<string>
  remove(name: string): Promise<void>
}
export interface CommandsApi { list(): Promise<CommandInfo[]>; expand(name: string, args: string): Promise<{ text: string; agent?: string } | null>; save(name: string, description: string, template: string, scope: 'project' | 'global'): Promise<string> }
export interface MemoryApi { get(): Promise<MemoryState>; set(scope: 'project' | 'global', text: string): Promise<void> }
export interface PermissionsApi { defaults(): Promise<PermissionRule[]> }

export interface ProvidersApi {
  test(cfg: ProviderConfig, apiKey?: string): Promise<{ ok: boolean; ms: number; message: string; models?: number }>
  discover(cfg: ProviderConfig, apiKey?: string): Promise<ModelInfo[]>
  setKey(providerId: string, key: string): Promise<void>
  /** which providers have a usable key (stored or from the environment) */
  keyStatus(): Promise<Record<string, 'stored' | 'env' | 'none'>>
}
