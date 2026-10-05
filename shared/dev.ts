// Shared types for developer tooling: terminal, git, language servers, debugging, project tasks.

// ───────────── Terminal ─────────────
export interface TerminalInfo { id: string; name: string; shell: string; pid: number; cwd: string; pty: boolean; exited?: number | null }
export interface TerminalCreateOptions { cwd?: string; shell?: string; args?: string[]; name?: string; cols?: number; rows?: number; env?: Record<string, string>; initialCommand?: string }

// ───────────── Git ─────────────
export interface GitFile {
  path: string
  origPath?: string
  /** porcelain status letters for index / worktree */
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflict: boolean
}
export interface GitStatus {
  isRepo: boolean
  gitMissing?: boolean
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
  merging: boolean
  rebasing: boolean
  cherryPicking: boolean
  stashCount: number
  head: string | null
}
export interface GitBranch { name: string; current: boolean; remote: boolean; upstream?: string; hash: string; subject?: string; date?: string; ahead?: number; behind?: number }
export interface GitCommit { hash: string; short: string; author: string; email: string; date: number; subject: string; body?: string; refs: string[]; parents: string[] }
export interface GitCommitDetail extends GitCommit { files: { path: string; oldPath?: string; status: string; added: number; removed: number }[] }
export interface GitStash { index: number; message: string; branch: string; date: number }
export interface GitDiffSides { original: string; modified: string; binary: boolean; originalLabel: string; modifiedLabel: string }
export interface GitConflictSides { ours: string; theirs: string; base: string; merged: string }
export interface GitBlameLine { line: number; hash: string; author: string; date: number; summary: string }

export interface GitApi {
  status(): Promise<GitStatus>
  init(): Promise<void>
  clone(url: string, destDir: string): Promise<string>
  diffSides(path: string, mode: 'staged' | 'unstaged' | 'commit', commit?: string): Promise<GitDiffSides>
  diffText(mode: 'staged' | 'unstaged' | 'all', paths?: string[]): Promise<string>
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  stageAll(): Promise<void>
  unstageAll(): Promise<void>
  discard(paths: string[]): Promise<void>
  applyPatch(patch: string, cached: boolean, reverse?: boolean): Promise<void>
  commit(opts: { message: string; amend?: boolean; signoff?: boolean; stageAll?: boolean }): Promise<string>
  branches(): Promise<GitBranch[]>
  checkout(name: string, create?: boolean, from?: string): Promise<void>
  deleteBranch(name: string, force?: boolean): Promise<void>
  renameBranch(from: string, to: string): Promise<void>
  merge(branch: string, opts?: { noFf?: boolean; squash?: boolean }): Promise<string>
  mergeAbort(): Promise<void>
  rebase(onto: string): Promise<string>
  rebaseAction(action: 'continue' | 'abort' | 'skip'): Promise<string>
  cherryPick(hash: string): Promise<string>
  revert(hash: string): Promise<string>
  stashList(): Promise<GitStash[]>
  stashPush(message?: string, includeUntracked?: boolean): Promise<string>
  stashApply(index: number, pop?: boolean): Promise<string>
  stashDrop(index: number): Promise<void>
  stashShow(index: number): Promise<string>
  remotes(): Promise<{ name: string; url: string }[]>
  addRemote(name: string, url: string): Promise<void>
  fetch(remote?: string): Promise<string>
  pull(opts?: { rebase?: boolean }): Promise<string>
  push(opts?: { remote?: string; branch?: string; setUpstream?: boolean; forceWithLease?: boolean; tags?: boolean }): Promise<string>
  log(opts?: { limit?: number; skip?: number; path?: string; branch?: string; all?: boolean; search?: string }): Promise<GitCommit[]>
  show(hash: string): Promise<GitCommitDetail>
  conflictSides(path: string): Promise<GitConflictSides>
  resolveConflict(path: string, resolution: 'ours' | 'theirs' | 'both' | 'merged', content?: string): Promise<void>
  blame(path: string): Promise<GitBlameLine[]>
  identity(): Promise<{ name: string; email: string }>
  setIdentity(name: string, email: string): Promise<void>
  ignore(pattern: string): Promise<void>
  createTag(name: string, message?: string): Promise<void>
}

// ───────────── Language servers ─────────────
export interface LspPos { line: number; col: number }
export interface LspRange { line: number; col: number; endLine: number; endCol: number }
export interface LspLocation extends LspRange { path: string; preview?: string }
export interface LspDiagnostic extends LspRange { severity: 'error' | 'warning' | 'info' | 'hint'; message: string; code?: string | number; source?: string; unnecessary?: boolean; deprecated?: boolean }
export interface LspSymbol extends LspRange { name: string; kind: string; detail?: string; containerName?: string; path?: string; children?: LspSymbol[] }
export interface LspTextEdit extends LspRange { newText: string }
export interface LspFileEdits { path: string; edits: LspTextEdit[] }
export interface LspCompletionItem {
  label: string; kind: string; detail?: string; documentation?: string; sortText?: string; insertText?: string; filterText?: string
  range?: LspRange; isSnippet?: boolean; data?: unknown; deprecated?: boolean; commitCharacters?: string[]; preselect?: boolean
}
export interface LspSignature { label: string; documentation?: string; parameters: { label: string; documentation?: string }[]; activeParameter?: number }
export interface LspSignatureHelp { signatures: LspSignature[]; activeSignature: number; activeParameter: number }
export interface LspCodeAction { title: string; kind?: string; edits: LspFileEdits[]; isPreferred?: boolean }
export interface LspCallItem { name: string; kind: string; path: string; detail?: string; range: LspRange; selection: LspRange; data?: unknown }
export interface LspServerStatus { id: string; label: string; languages: string[]; command?: string; state: 'running' | 'starting' | 'stopped' | 'missing' | 'error' | 'disabled'; message?: string }

export interface LspApi {
  open(path: string, text: string, languageId: string, version: number): Promise<void>
  change(path: string, text: string, version: number): Promise<void>
  close(path: string): Promise<void>
  definition(path: string, pos: LspPos): Promise<LspLocation[]>
  typeDefinition(path: string, pos: LspPos): Promise<LspLocation[]>
  implementation(path: string, pos: LspPos): Promise<LspLocation[]>
  references(path: string, pos: LspPos): Promise<LspLocation[]>
  hover(path: string, pos: LspPos): Promise<{ contents: string; range?: LspRange } | null>
  completion(path: string, pos: LspPos, trigger?: string): Promise<{ items: LspCompletionItem[]; incomplete: boolean }>
  completionResolve(path: string, pos: LspPos, item: LspCompletionItem): Promise<{ documentation?: string; detail?: string; additionalEdits?: LspTextEdit[] }>
  signatureHelp(path: string, pos: LspPos, trigger?: string): Promise<LspSignatureHelp | null>
  rename(path: string, pos: LspPos, newName: string): Promise<LspFileEdits[]>
  prepareRename(path: string, pos: LspPos): Promise<{ range: LspRange; text: string } | null>
  documentSymbols(path: string): Promise<LspSymbol[]>
  workspaceSymbols(query: string): Promise<LspSymbol[]>
  diagnostics(path: string): Promise<LspDiagnostic[]>
  codeActions(path: string, range: LspRange, diagnostics: LspDiagnostic[]): Promise<LspCodeAction[]>
  format(path: string, opts: { tabSize: number; insertSpaces: boolean }): Promise<LspTextEdit[]>
  organizeImports(path: string): Promise<LspFileEdits[]>
  callHierarchy(path: string, pos: LspPos, direction: 'prepare' | 'incoming' | 'outgoing', item?: LspCallItem): Promise<LspCallItem[]>
  status(): Promise<LspServerStatus[]>
  restart(id?: string): Promise<void>
  allDiagnostics(): Promise<Record<string, LspDiagnostic[]>>
  /** external formatter (black, gofmt …) configured in settings */
  externalFormat(path: string, text: string, languageId: string): Promise<string | null>
  applyEditsToDisk(files: LspFileEdits[]): Promise<void>
}

// ───────────── Debugging ─────────────
export interface LaunchConfig {
  name: string
  type: 'node' | 'node-attach'
  request: 'launch' | 'attach'
  program?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  runtimeExecutable?: string
  runtimeArgs?: string[]
  port?: number
  stopOnEntry?: boolean
}
export interface Breakpoint { id: string; path: string; line: number; enabled: boolean; condition?: string; logMessage?: string; verified?: boolean }
export interface DebugFrame { id: string; name: string; path: string; line: number; col: number; scopes: DebugScope[] }
export interface DebugScope { name: string; ref: string; expensive?: boolean }
export interface DebugVariable { name: string; value: string; type?: string; ref?: string; expandable: boolean }
export type DebugState = 'inactive' | 'starting' | 'running' | 'paused' | 'terminated'
export interface DebugSnapshot { state: DebugState; configName?: string; frames: DebugFrame[]; pauseReason?: string; exception?: string; pid?: number }
export interface DebugApi {
  start(cfg: LaunchConfig, debug: boolean, ctx?: { file?: string }): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  resume(): Promise<void>
  pause(): Promise<void>
  stepOver(): Promise<void>
  stepInto(): Promise<void>
  stepOut(): Promise<void>
  snapshot(): Promise<DebugSnapshot>
  setBreakpoints(path: string, bps: Breakpoint[]): Promise<Breakpoint[]>
  variables(ref: string): Promise<DebugVariable[]>
  evaluate(expr: string, frameId?: string): Promise<{ value: string; type?: string; ref?: string; expandable: boolean; error?: boolean }>
  setExceptionBreakpoints(mode: 'none' | 'uncaught' | 'all'): Promise<void>
  loadConfigs(): Promise<LaunchConfig[]>
  saveConfigs(cfgs: LaunchConfig[]): Promise<void>
}

// ───────────── Project tasks / tests / deploy / packages ─────────────
export interface ProjectScript { name: string; command: string; source: string; kind: 'script' | 'test' | 'build' | 'dev' | 'lint' | 'other' }
export interface ProjectDependency { name: string; version: string; dev: boolean }
export interface ProjectInfo {
  root: string
  languages: string[]
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'cargo' | 'go' | 'maven' | 'gradle' | 'dotnet' | 'none'
  scripts: ProjectScript[]
  dependencies: ProjectDependency[]
  testFramework: string | null
  testCommand: string | null
  deploy: { id: string; label: string; description: string; command?: string; file: string }[]
  frameworks: string[]
}
export interface ProjectApi {
  info(): Promise<ProjectInfo | null>
  installCommand(pkg: string, dev: boolean, uninstall?: boolean): Promise<string>
  outdated(): Promise<{ name: string; current: string; wanted: string; latest: string }[]>
}
