import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AgentConfig, ModelRef, PermissionRule, ReasoningEffort, Settings } from '../../shared/settings'
import { parseFrontmatter } from './frontmatter'
import { settings } from '../services/settings'
import { dataPath, PROJECT_DIR } from '../services/paths'
import * as P from './prompts'

const READ_ONLY = ['read', 'list', 'glob', 'grep', 'lsp', 'shell', 'shell_output', 'todowrite', 'todoread', 'skill', 'memory']
const WEB = ['websearch', 'webfetch']
const denyEdit: PermissionRule[] = [{ id: 'ro-edit', tool: 'edit', action: 'deny', note: 'This agent is read-only.' }]

export const BUILTIN_AGENTS: AgentConfig[] = [
  { id: 'build', name: 'Build', mode: 'primary', builtin: true, color: '#C4623F', description: 'Full implementation agent: reads, searches, edits, runs commands and tests, uses the web and sub-agents.', prompt: '', tools: ['*'], contextRules: { projectInstructions: true, memory: true, autoContext: true } },
  { id: 'plan', name: 'Plan', mode: 'primary', builtin: true, color: '#2563A8', description: 'Planning and analysis. Investigates the repository and produces an implementation plan without changing anything.', prompt: P.PLAN_PROMPT, tools: [...READ_ONLY, ...WEB, 'subagent', 'question'], permissions: denyEdit, reasoning: 'high', contextRules: { projectInstructions: true, memory: true, autoContext: true } },
  { id: 'general', name: 'General', mode: 'subagent', builtin: true, color: '#7A6FF0', description: 'General-purpose worker for multi-step tasks, research and parallel work.', prompt: P.GENERAL_PROMPT, tools: ['*', '!subagent', '!question'], contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'explore', name: 'Explore', mode: 'subagent', builtin: true, color: '#2F7D4F', description: 'Fast read-only exploration of a codebase: find files, trace code paths, answer "where/how" questions.', prompt: P.EXPLORE_PROMPT, tools: ['read', 'list', 'glob', 'grep', 'lsp', 'shell'], permissions: denyEdit, reasoning: 'low', contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'reviewer', name: 'Reviewer', mode: 'subagent', builtin: true, color: '#B26B00', description: 'Code review: correctness, security, performance and design issues with file:line findings.', prompt: P.REVIEWER_PROMPT, tools: [...READ_ONLY], permissions: denyEdit, reasoning: 'high', contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'debugger', name: 'Debugger', mode: 'subagent', builtin: true, color: '#C23B31', description: 'Investigates failures: reproduces them, finds the root cause and proposes a fix.', prompt: P.DEBUGGER_PROMPT, tools: [...READ_ONLY, ...WEB], permissions: denyEdit, reasoning: 'high', contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'tester', name: 'Tester', mode: 'subagent', builtin: true, color: '#1C6B86', description: 'Writes and runs tests following the project conventions; reports real failures.', prompt: P.TESTER_PROMPT, tools: ['*', '!subagent', '!question'], contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'researcher', name: 'Researcher', mode: 'subagent', builtin: true, color: '#8A3FC0', description: 'Web research and documentation gathering with cited sources.', prompt: P.RESEARCHER_PROMPT, tools: ['websearch', 'webfetch', 'read', 'list', 'glob', 'grep', 'memory'], permissions: denyEdit, contextRules: { projectInstructions: false, memory: false, autoContext: false } },
  { id: 'designer', name: 'Designer', mode: 'subagent', builtin: true, color: '#D9548C', description: 'UI/UX analysis: layout, accessibility, consistency and concrete design recommendations.', prompt: P.DESIGNER_PROMPT, tools: ['read', 'list', 'glob', 'grep', ...WEB], permissions: denyEdit, contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'security', name: 'Security', mode: 'subagent', builtin: true, color: '#9A2B2B', description: 'Security-oriented review: vulnerabilities, secrets, unsafe patterns and dependency risks.', prompt: P.SECURITY_PROMPT, tools: [...READ_ONLY, ...WEB], permissions: denyEdit, reasoning: 'high', contextRules: { projectInstructions: true, memory: false, autoContext: false } },
  { id: 'docs', name: 'Docs', mode: 'subagent', builtin: true, color: '#4D7C3A', description: 'Generates and updates documentation so it matches the code.', prompt: P.DOCS_PROMPT, tools: ['*', '!subagent', '!question', '!shell_kill'], contextRules: { projectInstructions: true, memory: false, autoContext: false } }
]

function parseModelRef(v: unknown): ModelRef | undefined {
  if (typeof v !== 'string' || !v.includes('/')) return undefined
  const i = v.indexOf('/')
  return { provider: v.slice(0, i), model: v.slice(i + 1) }
}

function parseToolList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  if (v && typeof v === 'object') return Object.entries(v as Record<string, boolean>).map(([k, on]) => (on ? k : `!${k}`))
  return ['*']
}

function parsePermissions(v: unknown, id: string): PermissionRule[] {
  if (!v || typeof v !== 'object') return []
  const out: PermissionRule[] = []
  for (const [tool, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out.push({ id: `${id}-${tool}`, tool, action: val as PermissionRule['action'] })
    else if (val && typeof val === 'object') for (const [pattern, action] of Object.entries(val as Record<string, string>)) out.push({ id: `${id}-${tool}-${pattern}`, tool, pattern, action: action as PermissionRule['action'] })
  }
  return out
}

async function loadAgentDir(dir: string, source: 'global-file' | 'project-file'): Promise<AgentConfig[]> {
  let files: string[] = []
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')) } catch { return [] }
  const out: AgentConfig[] = []
  for (const f of files) {
    try {
      const { data, body } = parseFrontmatter(await fsp.readFile(join(dir, f), 'utf8'))
      const id = String(data.id ?? f.replace(/\.md$/, '')).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      out.push({
        id, name: String(data.name ?? id), description: String(data.description ?? ''), mode: (['primary', 'subagent', 'all'].includes(String(data.mode)) ? data.mode : 'all') as AgentConfig['mode'],
        prompt: body.trim(), model: parseModelRef(data.model), temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
        reasoning: data.reasoning as ReasoningEffort | undefined, tools: parseToolList(data.tools), permissions: parsePermissions(data.permissions, id),
        maxSteps: typeof data.maxSteps === 'number' ? data.maxSteps : undefined, color: typeof data.color === 'string' ? data.color : undefined, hidden: data.hidden === true,
        contextRules: { projectInstructions: true, memory: true, autoContext: false }, source, filePath: join(dir, f)
      })
    } catch { /* skip malformed */ }
  }
  return out
}

/** Built-in agents, overridden/extended by settings, the global agents folder and the project's .tgg/agents. */
export async function loadAgents(root: string | null, s: Settings = settings.get()): Promise<AgentConfig[]> {
  const byId = new Map<string, AgentConfig>()
  for (const a of BUILTIN_AGENTS) byId.set(a.id, { ...a, source: 'builtin' })
  for (const a of s.agents) byId.set(a.id, { ...(byId.get(a.id) ?? {}), ...a, source: byId.get(a.id)?.source === 'builtin' ? 'builtin' : 'settings' })
  for (const a of await loadAgentDir(dataPath('agents'), 'global-file')) byId.set(a.id, { ...(byId.get(a.id) ?? {}), ...a })
  if (root) for (const a of await loadAgentDir(join(root, PROJECT_DIR, 'agents'), 'project-file')) byId.set(a.id, { ...(byId.get(a.id) ?? {}), ...a })
  return [...byId.values()]
}

/** Does an agent tool list ("*", "read", "mcp__*", "!edit") allow the tool? */
export function agentAllowsTool(agent: AgentConfig, toolName: string): boolean {
  let allowed = false
  for (const entry of agent.tools) {
    const neg = entry.startsWith('!')
    const pat = neg ? entry.slice(1) : entry
    const hit = pat === '*' || pat === toolName || (pat.endsWith('*') && toolName.startsWith(pat.slice(0, -1)))
    if (hit) allowed = !neg
  }
  return allowed
}
