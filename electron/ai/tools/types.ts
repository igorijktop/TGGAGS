import { z } from 'zod'
import type { ImageData, PermissionRequest, Session, Todo, ToolMeta, QuestionItem } from '../../../shared/ai'
import type { AgentConfig, PermissionCategory, Settings } from '../../../shared/settings'

/** Thrown by tools for expected failures. The message is returned to the model verbatim. */
export class ToolError extends Error {
  constructor(message: string, public meta?: ToolMeta) { super(message); this.name = 'ToolError' }
}

export interface PermissionCheck {
  category: PermissionCategory
  /** Tool name used for rule matching (defaults to the executing tool) */
  toolName?: string
  /** Normalised resources: absolute paths, commands, hostnames, tool ids … */
  resources: string[]
  title: string
  detail?: string
  preview?: PermissionRequest['preview']
  /** resources are filesystem paths (enables project-boundary checks) */
  isPath?: boolean
  /** downgrade an "allow" to "ask" (e.g. shell commands with redirects) */
  requireAsk?: boolean
}

export interface Described {
  /** Human title for the tool card, e.g. "Editing src/api.ts" */
  title: string
  checks: PermissionCheck[]
  /** Prepared data handed to execute() (e.g. computed new file content) */
  plan?: unknown
}

export interface ToolResult {
  output: string
  title?: string
  meta?: ToolMeta
  images?: ImageData[]
  isError?: boolean
}

export interface ToolRuntime {
  session: Session
  /** Replace the todo list and notify the UI */
  setTodos(todos: Todo[]): void
  ask(questions: QuestionItem[]): Promise<Record<string, string | string[]> | null>
  runSubagent(opts: { agent: string; prompt: string; description: string; signal: AbortSignal; parentToolCallId: string }): Promise<{ text: string; sessionId: string; steps: number }>
  /** Record that a file was read (enables edit freshness checks) */
  markRead(path: string, mtimeMs: number): void
  lastRead(path: string): number | undefined
  recordChange(c: { path: string; before: string | null; after: string | null; toolCallId: string }): Promise<void>
  loadSkill(name: string): Promise<{ name: string; content: string; dir: string; files: string[] } | null>
  listSkills(): { name: string; description: string }[]
  memory: { read(scope: 'project' | 'global'): Promise<string>; write(scope: 'project' | 'global', text: string): Promise<void> }
  progress(update: { title?: string; output?: string; meta?: ToolMeta }): void
}

export interface ToolContext {
  sessionId: string
  agent: AgentConfig
  root: string
  cwd: string
  signal: AbortSignal
  toolCallId: string
  settings: Settings
  runtime: ToolRuntime
}

export interface ToolDef {
  name: string
  description: string
  category: PermissionCategory
  parameters: Record<string, unknown>
  source: 'builtin' | 'mcp' | 'plugin' | 'custom'
  server?: string
  timeoutMs?: number
  /** Read-only tools may be executed concurrently */
  readOnly?: boolean
  validate(input: unknown): { ok: true; value: unknown } | { ok: false; error: string }
  describe(input: unknown, ctx: ToolContext): Promise<Described> | Described
  execute(input: unknown, ctx: ToolContext, plan?: unknown): Promise<ToolResult>
}

export interface DefineToolOptions<S extends z.ZodType> {
  name: string
  description: string
  category: PermissionCategory
  schema: S
  timeoutMs?: number
  readOnly?: boolean
  describe(input: z.infer<S>, ctx: ToolContext): Promise<Described> | Described
  execute(input: z.infer<S>, ctx: ToolContext, plan?: unknown): Promise<ToolResult>
}

export function zodToParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete json.$schema
  return json
}

export function formatZodError(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; ')
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
const KEY_ALIASES: Record<string, string> = { path: 'filePath', file: 'filePath', filepath: 'filePath', file_path: 'filePath', filename: 'filePath', cmd: 'command', dir: 'path', directory: 'path', dirPath: 'path' }

/** Models frequently use snake_case or synonymous argument names; map them onto the declared schema keys. */
export function normalizeKeys(input: unknown, known: string[]): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (known.includes(k)) { out[k] = v; continue }
    const c = camel(k)
    if (known.includes(c)) { out[c] = out[c] ?? v; continue }
    const a = KEY_ALIASES[k] ?? KEY_ALIASES[k.toLowerCase()]
    if (a && known.includes(a) && out[a] === undefined) { out[a] = v; continue }
    out[k] = v
  }
  return out
}

export function defineTool<S extends z.ZodType>(o: DefineToolOptions<S>): ToolDef {
  const parameters = zodToParameters(o.schema)
  const known = Object.keys((parameters.properties as Record<string, unknown> | undefined) ?? {})
  return {
    name: o.name, description: o.description, category: o.category, source: 'builtin', timeoutMs: o.timeoutMs, readOnly: o.readOnly,
    parameters,
    validate(input) {
      const r = o.schema.safeParse(normalizeKeys(input ?? {}, known))
      return r.success ? { ok: true, value: r.data } : { ok: false, error: `Invalid arguments for ${o.name}: ${formatZodError(r.error)}` }
    },
    describe: (i, c) => o.describe(i as z.infer<S>, c),
    execute: (i, c, p) => o.execute(i as z.infer<S>, c, p)
  }
}

/** Minimal JSON-Schema validator for tools that bring their own schema (MCP, custom, plugins). */
export function validateJsonSchema(schema: Record<string, unknown> | undefined, value: unknown, path = 'input'): string | null {
  if (!schema) return null
  const type = schema.type as string | string[] | undefined
  const types = Array.isArray(type) ? type : type ? [type] : []
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (types.length && !types.some(t => t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(value)) || (t === 'number' && actual === 'number'))) {
    if (!(value === undefined)) return `${path}: expected ${types.join('|')}, got ${actual}`
  }
  if (Array.isArray(schema.enum) && value !== undefined && !(schema.enum as unknown[]).includes(value)) return `${path}: must be one of ${(schema.enum as unknown[]).map(String).join(', ')}`
  if (actual === 'object' && value) {
    const obj = value as Record<string, unknown>
    for (const r of (schema.required as string[] | undefined) ?? []) if (obj[r] === undefined) return `${path}.${r}: required`
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const [k, sub] of Object.entries(props)) if (obj[k] !== undefined) { const e = validateJsonSchema(sub, obj[k], `${path}.${k}`); if (e) return e }
  }
  if (actual === 'array' && schema.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) { const e = validateJsonSchema(schema.items as Record<string, unknown>, (value as unknown[])[i], `${path}[${i}]`); if (e) return e }
  }
  return null
}

export function defineRawTool(o: {
  name: string; description: string; category: PermissionCategory; parameters: Record<string, unknown>; source: ToolDef['source']; server?: string; timeoutMs?: number; readOnly?: boolean
  describe?: ToolDef['describe']; execute: ToolDef['execute']
}): ToolDef {
  return {
    name: o.name, description: o.description, category: o.category, parameters: o.parameters, source: o.source, server: o.server, timeoutMs: o.timeoutMs, readOnly: o.readOnly,
    validate(input) {
      const v = input ?? {}
      const err = validateJsonSchema(o.parameters, v)
      return err ? { ok: false, error: `Invalid arguments for ${o.name}: ${err}` } : { ok: true, value: v }
    },
    describe: o.describe ?? ((_i, _c) => ({ title: o.name, checks: [{ category: o.category, toolName: o.name, resources: [o.name], title: o.name }] })),
    execute: o.execute
  }
}
