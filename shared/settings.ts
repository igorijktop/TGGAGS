// Settings schema shared by the main process and the renderer.
// Secrets (API keys) are never part of Settings – they live in the encrypted credential store.

export interface ModelRef { provider: string; model: string }

export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'stability' | 'a1111'
export type Modality = 'chat' | 'image' | 'embedding'

export interface ModelInfo {
  id: string
  name?: string
  modality: Modality
  contextWindow?: number
  maxOutput?: number
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  /** USD per 1M tokens */
  inputPrice?: number
  outputPrice?: number
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  /** Environment variable consulted when no stored key exists */
  apiKeyEnv?: string
  requiresKey: boolean
  headers?: Record<string, string>
  models: ModelInfo[]
  enabled: boolean
  preset?: string
  local?: boolean
}

export type PermissionAction = 'allow' | 'ask' | 'deny'
export type PermissionCategory =
  | 'read' | 'edit' | 'shell' | 'git' | 'web' | 'subagent' | 'skill' | 'lsp' | 'mcp'
  | 'plugin' | 'image' | 'external_api' | 'external_dir' | 'memory' | 'question' | 'todo' | 'custom'

export interface PermissionRule {
  id: string
  /** category ("shell"), tool name ("edit"), or "*" */
  tool: string
  /** glob on the resource: path for file tools, command for shell/git, domain for web, tool id for mcp */
  pattern?: string
  agent?: string
  provider?: string
  action: PermissionAction
  note?: string
}

export type PermissionMode = 'ask' | 'auto-edit' | 'plan' | 'yolo'

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentConfig {
  id: string
  name: string
  description: string
  mode: 'primary' | 'subagent' | 'all'
  prompt: string
  model?: ModelRef
  temperature?: number
  reasoning?: ReasoningEffort
  /** tool names or globs ("*", "mcp__*"); prefix with "!" to remove */
  tools: string[]
  permissions?: PermissionRule[]
  maxSteps?: number
  color?: string
  builtin?: boolean
  /** where the definition came from (set when loaded) */
  source?: 'builtin' | 'settings' | 'global-file' | 'project-file'
  filePath?: string
  hidden?: boolean
  contextRules?: {
    projectInstructions?: boolean
    memory?: boolean
    autoContext?: boolean
    extraInstructions?: string
  }
}

export interface RouterRule {
  id: string
  when: { agent?: string; hasImages?: boolean; minTokens?: number; keywords?: string[] }
  use: ModelRef
}

export interface RouterConfig {
  enabled: boolean
  roles: { default?: ModelRef; plan?: ModelRef; small?: ModelRef; vision?: ModelRef; long?: ModelRef }
  rules: RouterRule[]
  fallbacks: ModelRef[]
}

export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  timeoutMs?: number
}

export type HookEvent = 'session.start' | 'message.before' | 'tool.before' | 'tool.after' | 'file.edited' | 'turn.end' | 'error'

export interface HookConfig {
  id: string
  event: HookEvent
  /** glob matched against the tool name (tool.* events) */
  match?: string
  command: string
  blocking?: boolean
  timeoutMs?: number
  enabled: boolean
}

export interface LspServerConfig { command: string; args?: string[]; enabled: boolean; languages: string[]; extensions?: string[] }

export interface FormatterConfig { command: string; args?: string[]; enabled: boolean }

export interface Settings {
  appearance: {
    theme: string
    uiScale: number
    chatFont: 'serif' | 'sans' | 'mono'
    motion: 'system' | 'reduced'
    activityBarLabels: boolean
    compact: boolean
  }
  editor: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    tabSize: number
    insertSpaces: boolean
    wordWrap: 'off' | 'on' | 'bounded'
    minimap: boolean
    cursorStyle: 'line' | 'block' | 'underline'
    cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid'
    lineNumbers: 'on' | 'off' | 'relative'
    renderWhitespace: 'none' | 'boundary' | 'selection' | 'all'
    bracketPairColorization: boolean
    ligatures: boolean
    stickyScroll: boolean
    folding: boolean
    breadcrumbs: boolean
    smoothScrolling: boolean
    formatOnSave: boolean
    autoSave: 'off' | 'afterDelay' | 'onFocusChange'
    autoSaveDelay: number
  }
  terminal: { shell: string; fontSize: number; cursorStyle: 'block' | 'underline' | 'bar'; scrollback: number; copyOnSelect: boolean }
  git: { autoFetch: boolean; confirmSync: boolean }
  ai: {
    defaultAgent: string
    defaultModel: ModelRef | null
    permissionMode: PermissionMode
    reasoning: ReasoningEffort
    maxSteps: number
    autoCompact: boolean
    compactThreshold: number
    autoContext: boolean
    showReasoning: boolean
    requestTimeoutSec: number
    maxRetries: number
    systemPromptSuffix: string
    responseLanguage: string
  }
  providers: ProviderConfig[]
  router: RouterConfig
  permissions: { rules: PermissionRule[] }
  context: { excludePatterns: string[]; redactSecrets: boolean; maxFileTokens: number; maxItemTokens: number }
  agents: AgentConfig[]
  mcp: { servers: Record<string, McpServerConfig> }
  lsp: { enabled: boolean; typescript: boolean; servers: Record<string, LspServerConfig> }
  formatters: Record<string, FormatterConfig>
  hooks: HookConfig[]
  web: { searchProvider: 'duckduckgo' | 'brave' | 'tavily' | 'searxng'; searxngUrl: string; userAgent: string; maxFetchChars: number }
  github: { enabled: boolean }
  images: { defaultModel: ModelRef | null; saveToProject: boolean }
  extensions: { disabled: string[]; registryUrl: string }
  keybindings: Record<string, string>
  /** Persisted UI state that should survive restarts */
  ui: {
    sidebarWidth: number
    aiPanelWidth: number
    panelHeight: number
    sidebarVisible: boolean
    aiPanelVisible: boolean
    panelVisible: boolean
    lastView: string
    recentProjects: string[]
    lastProject: string | null
    onboarded: boolean
  }
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.venv/**',
  '**/__pycache__/**', '**/target/**', '**/*.min.js', '**/*.map', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.ico', '**/*.pdf', '**/*.zip', '**/*.exe', '**/*.dll'
]

let ruleSeq = 0
const rule = (tool: string, action: PermissionAction, pattern?: string, note?: string): PermissionRule =>
  ({ id: `default-${++ruleSeq}`, tool, pattern, action, note })

export function defaultPermissionRules(): PermissionRule[] {
  ruleSeq = 0
  return [
    rule('read', 'allow', undefined, 'Reading project files is safe'),
    rule('read', 'deny', '**/.env', 'Secrets files are never read by the agent'),
    rule('read', 'deny', '**/.env.*'),
    rule('read', 'allow', '**/.env.example'),
    rule('read', 'allow', '**/.env.sample'),
    rule('external_dir', 'ask', undefined, 'Anything outside the project folder needs approval'),
    rule('edit', 'ask'),
    rule('edit', 'deny', '**/.env'),
    rule('edit', 'deny', '**/.git/**'),
    rule('shell', 'ask'),
    ...[
      'ls', 'ls *', 'dir', 'dir *', 'pwd', 'cd *', 'cat *', 'type *', 'head *', 'tail *', 'wc *', 'echo *', 'which *', 'where *', 'whoami',
      'node -v', 'node --version', 'npm -v', 'npm --version', 'npm ls*', 'npm run lint*', 'npm test*', 'npm run test*', 'npm run build*', 'npm run typecheck*',
      'npx tsc --noEmit*', 'tsc --noEmit*', 'pnpm test*', 'yarn test*', 'pytest*', 'python -m pytest*', 'go test*', 'go vet*', 'cargo test*', 'cargo check*', 'cargo clippy*',
      'git status*', 'git diff*', 'git log*', 'git show*', 'git branch', 'git branch -a*', 'git branch --list*', 'git remote -v', 'git rev-parse*', 'git stash list*', 'git blame*', 'git ls-files*'
    ].map(p => rule('shell', 'allow', p)),
    ...[
      'rm -rf /', 'rm -rf /*', 'rm -rf ~*', 'rm -rf $HOME*', 'sudo rm *', 'mkfs*', 'dd if=*', ':(){*', 'shutdown*', 'reboot*',
      'format *', 'del /s /q c:*', 'rd /s /q c:*', 'Remove-Item -Recurse -Force C:*', 'chmod -R 777 /*'
    ].map(p => rule('shell', 'deny', p, 'Destructive command blocked')),
    rule('shell', 'ask', '*.env*', 'Might read secrets'),
    rule('shell', 'ask', '*id_rsa*', 'Might read secrets'),
    rule('shell', 'ask', '*.pem*', 'Might read secrets'),
    rule('shell', 'ask', 'git push*'),
    rule('shell', 'ask', 'git commit*'),
    rule('shell', 'ask', 'git reset --hard*'),
    rule('shell', 'ask', 'git clean*'),
    rule('git', 'allow', 'status*'), rule('git', 'allow', 'diff*'), rule('git', 'allow', 'log*'), rule('git', 'allow', 'show*'),
    rule('git', 'ask', 'commit*'), rule('git', 'ask', 'push*'), rule('git', 'ask', 'merge*'), rule('git', 'ask', 'rebase*'),
    rule('web', 'ask'),
    rule('subagent', 'allow'),
    rule('skill', 'allow'),
    rule('lsp', 'allow'),
    rule('memory', 'allow'),
    rule('todo', 'allow'),
    rule('question', 'allow'),
    rule('mcp', 'ask'),
    rule('plugin', 'ask'),
    rule('custom', 'ask'),
    rule('image', 'ask'),
    rule('external_api', 'ask')
  ]
}

export function defaultSettings(): Settings {
  return {
    appearance: { theme: 'tgg-light', uiScale: 1, chatFont: 'serif', motion: 'system', activityBarLabels: true, compact: false },
    editor: {
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      fontSize: 13.5, lineHeight: 1.65, tabSize: 2, insertSpaces: true, wordWrap: 'off', minimap: true,
      cursorStyle: 'line', cursorBlinking: 'smooth', lineNumbers: 'on', renderWhitespace: 'selection',
      bracketPairColorization: true, ligatures: false, stickyScroll: true, folding: true, breadcrumbs: true, smoothScrolling: true,
      formatOnSave: false, autoSave: 'afterDelay', autoSaveDelay: 1200
    },
    terminal: { shell: '', fontSize: 13, cursorStyle: 'bar', scrollback: 8000, copyOnSelect: false },
    git: { autoFetch: false, confirmSync: true },
    ai: {
      defaultAgent: 'build', defaultModel: null, permissionMode: 'auto-edit', reasoning: 'medium', maxSteps: 60,
      autoCompact: true, compactThreshold: 0.8, autoContext: true, showReasoning: true, requestTimeoutSec: 180, maxRetries: 3,
      systemPromptSuffix: '', responseLanguage: ''
    },
    providers: [],
    router: { enabled: false, roles: {}, rules: [], fallbacks: [] },
    permissions: { rules: [] },
    context: { excludePatterns: [...DEFAULT_EXCLUDES], redactSecrets: true, maxFileTokens: 12000, maxItemTokens: 12000 },
    agents: [],
    mcp: { servers: {} },
    lsp: {
      enabled: true, typescript: true,
      servers: {
        python: { command: 'pyright-langserver', args: ['--stdio'], enabled: true, languages: ['python'], extensions: ['.py'] },
        go: { command: 'gopls', args: [], enabled: true, languages: ['go'], extensions: ['.go'] },
        rust: { command: 'rust-analyzer', args: [], enabled: true, languages: ['rust'], extensions: ['.rs'] },
        cpp: { command: 'clangd', args: [], enabled: true, languages: ['c', 'cpp'], extensions: ['.c', '.h', '.cpp', '.hpp', '.cc'] }
      }
    },
    formatters: {
      python: { command: 'black', args: ['-q', '-'], enabled: false },
      go: { command: 'gofmt', args: [], enabled: false },
      rust: { command: 'rustfmt', args: ['--emit', 'stdout'], enabled: false }
    },
    hooks: [],
    web: { searchProvider: 'duckduckgo', searxngUrl: '', userAgent: 'Mozilla/5.0 (compatible; TGGAGS-IDE/1.0)', maxFetchChars: 60000 },
    github: { enabled: true },
    images: { defaultModel: null, saveToProject: false },
    extensions: { disabled: [], registryUrl: '' },
    keybindings: {},
    ui: {
      sidebarWidth: 290, aiPanelWidth: 440, panelHeight: 280, sidebarVisible: true, aiPanelVisible: true, panelVisible: false,
      lastView: 'explorer', recentProjects: [], lastProject: null, onboarded: false
    }
  }
}

export function refKey(r: ModelRef | null | undefined): string { return r ? `${r.provider}::${r.model}` : '' }
export function sameRef(a?: ModelRef | null, b?: ModelRef | null): boolean { return !!a && !!b && a.provider === b.provider && a.model === b.model }
