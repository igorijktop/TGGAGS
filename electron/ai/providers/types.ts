import type { ImageData } from '../../../shared/ai'
import type { ModelInfo, ProviderConfig, ReasoningEffort } from '../../../shared/settings'

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ReasoningBlock { text: string; signature?: string; redacted?: string }

export type ChatContent = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string }

export type ChatMessage =
  | { role: 'user'; content: ChatContent[] }
  | { role: 'assistant'; text: string; reasoning?: ReasoningBlock[]; toolCalls?: { id: string; name: string; input: unknown; providerMeta?: Record<string, unknown> }[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean; images?: ImageData[] }

export interface ChatRequest {
  model: string
  modelInfo?: ModelInfo
  system?: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  reasoning?: ReasoningEffort
  /** ask the provider to return readable reasoning summaries */
  showReasoning?: boolean
  signal?: AbortSignal
  idleTimeoutMs?: number
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'other'

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'reasoning_block'; signature?: string; redacted?: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_args'; id: string; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; parseError?: string; providerMeta?: Record<string, unknown> }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'notice'; text: string }
  | { type: 'finish'; reason: FinishReason; detail?: string }

export interface ChatProvider {
  readonly config: ProviderConfig
  streamChat(req: ChatRequest): AsyncGenerator<StreamEvent>
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'not_found' | 'network' | 'timeout' | 'aborted' | 'context_length' | 'other'

export class ProviderError extends Error {
  status?: number
  kind: ProviderErrorKind
  retryable: boolean
  retryAfterMs?: number
  constructor(message: string, kind: ProviderErrorKind, opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network' || kind === 'timeout')
    this.retryAfterMs = opts.retryAfterMs
  }
}

export function classifyStatus(status: number, message: string): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status === 408) return 'timeout'
  if (status === 413 || (status === 400 && /context|too long|too many tokens|maximum.*length|exceeds/i.test(message))) return 'context_length'
  if (status === 529 || status === 503 || status === 502 || status === 500 || status === 504) return 'overloaded'
  if (status >= 400 && status < 500) return 'bad_request'
  return 'other'
}
