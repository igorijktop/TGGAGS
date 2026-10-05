import type { ModelRef, PermissionAction, PermissionCategory, PermissionMode, PermissionRule, ReasoningEffort } from './settings'

// ───────────────────────── Messages ─────────────────────────

export interface ImageData { mime: string; data: string; name?: string }

export type ToolState = 'pending' | 'running' | 'completed' | 'error' | 'denied'

export interface ToolPart {
  type: 'tool'
  id: string
  name: string
  input: unknown
  state: ToolState
  output?: string
  /** short human summary shown in the card header, e.g. "Reading src/api.ts" */
  title?: string
  /** structured extras: diff, counts, exit code, child session id … */
  meta?: ToolMeta
  /** opaque provider data that must be echoed back (e.g. Gemini thought signatures) */
  providerMeta?: Record<string, unknown>
  startedAt?: number
  endedAt?: number
}

export interface ToolMeta {
  diff?: { path: string; before: string; after: string; added: number; removed: number }[]
  exitCode?: number | null
  childSessionId?: string
  matches?: number
  images?: ImageData[]
  truncated?: boolean
  path?: string
  [k: string]: unknown
}

export type Part =
  | { type: 'text'; text: string; synthetic?: boolean }
  | { type: 'reasoning'; text: string; signature?: string; redacted?: string }
  | ({ type: 'image' } & ImageData)
  | ToolPart

export interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number }

export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  ts: number
  agent?: string
  model?: ModelRef
  usage?: Usage
  finish?: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted'
  error?: string
  /** compaction summary message (replaces earlier history in the prompt) */
  summary?: boolean
  /** user-visible note that is not sent to the model */
  notice?: boolean
}

export interface Todo { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: 'high' | 'medium' | 'low' }

export interface Session {
  id: string
  title: string
  projectRoot: string | null
  createdAt: number
  updatedAt: number
  agent: string
  model?: ModelRef | null
  mode?: PermissionMode
  reasoning?: ReasoningEffort
  messages: Message[]
  todos: Todo[]
  context: ContextItem[]
  usage: { input: number; output: number; cost: number; steps: number }
  parentId?: string
  forkedFrom?: string
  /** id of the last message folded into the compaction summary */
  compactedUpTo?: string
  /** calibration factor between estimated and provider-reported tokens */
  tokenRatio?: number
  titled?: boolean
}

export interface SessionMeta {
  id: string; title: string; projectRoot: string | null; createdAt: number; updatedAt: number; agent: string
  messageCount: number; preview: string; parentId?: string; running?: boolean
}

// ───────────────────────── Context ─────────────────────────

export type ContextKind = 'file' | 'folder' | 'selection' | 'diff' | 'terminal' | 'diagnostics' | 'url' | 'image' | 'note' | 'tabs' | 'instructions' | 'memory' | 'skill'

export interface ContextItem {
  id: string
  kind: ContextKind
  label: string
  path?: string
  range?: { startLine: number; endLine: number }
  content?: string
  image?: ImageData
  tokens: number
  enabled: boolean
  pinned: boolean
  priority: 1 | 2 | 3 | 4 | 5
  auto: boolean
  truncated?: boolean
  note?: string
  /** removed automatically once the turn that used it has finished */
  once?: boolean
}

export interface ContextSnapshot {
  items: ContextItem[]
  used: number
  window: number
  history: number
  system: number
  budgetItems: number
}

export interface EditorContext {
  activeFile?: string
  selection?: { path: string; startLine: number; endLine: number; text: string }
  openTabs: string[]
  diagnostics?: { path: string; line: number; severity: 'error' | 'warning' | 'info'; message: string }[]
  terminalTail?: string
}

// ───────────────────────── Run requests & events ─────────────────────────

export interface Mention { kind: 'file' | 'folder' | 'agent' | 'url'; value: string }

export interface SendRequest {
  sessionId?: string
  text: string
  images?: ImageData[]
  agent?: string
  model?: ModelRef | null
  reasoning?: ReasoningEffort
  mode?: PermissionMode
  mentions?: Mention[]
  editor?: EditorContext
}

export type RunStatus = 'idle' | 'thinking' | 'tool' | 'waiting_permission' | 'waiting_question' | 'compacting' | 'retrying'

export interface PermissionRequest {
  id: string
  sessionId: string
  agent: string
  tool: string
  category: PermissionCategory
  title: string
  detail?: string
  resources: string[]
  preview?: { kind: 'diff'; path: string; before: string; after: string } | { kind: 'command'; command: string; cwd?: string } | { kind: 'text'; text: string }
  suggestions: { label: string; rule: Omit<PermissionRule, 'id'> }[]
  ts: number
}

export interface PermissionReply {
  id: string
  decision: 'once' | 'session' | 'always' | 'deny'
  rule?: Omit<PermissionRule, 'id'>
  feedback?: string
}

export interface QuestionOption { label: string; description?: string }
export interface QuestionItem { id: string; question: string; header?: string; options?: QuestionOption[]; multiple?: boolean; allowCustom?: boolean }
export interface QuestionRequest { id: string; sessionId: string; questions: QuestionItem[]; ts: number }
export interface QuestionReply { id: string; answers?: Record<string, string | string[]>; cancelled?: boolean }

export interface FileChange { path: string; rel: string; status: 'created' | 'modified' | 'deleted'; added: number; removed: number; messageId?: string; before: string | null; after: string | null }

export type AiEvent =
  | { type: 'session'; session: SessionMeta }
  | { type: 'message_start'; sessionId: string; message: Message }
  | { type: 'delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'reasoning'; delta: string }
  | { type: 'part'; sessionId: string; messageId: string; index: number; part: Part }
  | { type: 'message_end'; sessionId: string; message: Message }
  | { type: 'message'; sessionId: string; message: Message }
  | { type: 'status'; sessionId: string; status: RunStatus; detail?: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; id: string; sessionId: string }
  | { type: 'question_request'; request: QuestionRequest }
  | { type: 'question_resolved'; id: string; sessionId: string }
  | { type: 'todos'; sessionId: string; todos: Todo[] }
  | { type: 'context'; sessionId: string; snapshot: ContextSnapshot }
  | { type: 'usage'; sessionId: string; usage: Session['usage'] }
  | { type: 'changes'; sessionId: string; changes: FileChange[] }
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'reload'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'done'; sessionId: string; reason: 'complete' | 'aborted' | 'error' | 'max_steps' }

// ───────────────────────── Agents / tools / skills / commands ─────────────────────────

export interface ToolInfo { name: string; description: string; category: PermissionCategory; source: 'builtin' | 'mcp' | 'plugin' | 'custom'; schema?: unknown; server?: string }
export interface SkillInfo { name: string; description: string; path: string; source: 'project' | 'global' }
export interface CommandInfo { name: string; description: string; template: string; agent?: string; source: 'builtin' | 'project' | 'global' | 'extension'; hint?: string }

export interface PermissionEvaluation { action: PermissionAction; rule?: PermissionRule }

export interface MemoryState { project: string; global: string; projectPath: string | null; globalPath: string }

export interface UsageStats {
  sessions: number; messages: number; tokens: number; activeDays: number; peakHour: number | null; favoriteModel: string | null
  daily: { date: string; count: number }[]; byModel: { model: string; tokens: number; messages: number }[]
}

// ───────────────────────── Benchmarks & routing ─────────────────────────

export interface BenchCase { id: string; name: string; prompt: string; check?: { type: 'contains' | 'regex' | 'json'; value?: string }; category: string }
export interface BenchResult {
  id: string
  caseId: string
  model: ModelRef
  ok: boolean
  passed?: boolean
  ttftMs?: number
  totalMs: number
  inputTokens: number
  outputTokens: number
  tokensPerSec: number
  cost?: number
  error?: string
  excerpt?: string
  ts: number
}
