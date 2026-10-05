import type { AgentConfig } from '../../../shared/settings'
import type { ToolInfo } from '../../../shared/ai'
import { agentAllowsTool } from '../agents'
import { readTool, listTool, globTool, grepTool, editTool, writeTool, applyPatchTool } from './builtin/files'
import { shellTool, shellOutputTool, shellKillTool } from './builtin/shell'
import { webfetchTool, websearchTool } from './builtin/web'
import { todowriteTool, todoreadTool, questionTool, memoryTool, makeSkillTool, makeSubagentTool } from './builtin/meta'
import type { ToolDef } from './types'

const external = new Map<string, ToolDef[]>()
const staticTools: ToolDef[] = [readTool, listTool, globTool, grepTool, editTool, writeTool, applyPatchTool, shellTool, shellOutputTool, shellKillTool, webfetchTool, websearchTool, todowriteTool, todoreadTool, questionTool, memoryTool]
const lateBuiltins: (() => ToolDef[])[] = []

/** Tools implemented in other modules (lsp, image generation …) register themselves here. */
export function registerBuiltinFactory(f: () => ToolDef[]): void { lateBuiltins.push(f) }

export function registerExternalTools(key: string, tools: ToolDef[]): void { external.set(key, tools) }
export function unregisterExternalTools(key: string): void { external.delete(key) }

export interface RegistryDeps {
  skills: () => { name: string; description: string }[]
  subagents: () => { id: string; name: string; description: string }[]
}

export function allTools(deps: RegistryDeps): ToolDef[] {
  const out: ToolDef[] = [...staticTools]
  for (const f of lateBuiltins) out.push(...f())
  out.push(makeSkillTool(deps.skills), makeSubagentTool(deps.subagents))
  for (const list of external.values()) out.push(...list)
  // later definitions win on name clashes
  const byName = new Map<string, ToolDef>()
  for (const t of out) byName.set(t.name, t)
  return [...byName.values()]
}

export function toolsForAgent(agent: AgentConfig, deps: RegistryDeps, isSub: boolean): ToolDef[] {
  return allTools(deps).filter(t => agentAllowsTool(agent, t.name) && !(isSub && t.name === 'subagent' && !agentAllowsTool(agent, 'subagent')))
}

export function toolInfo(deps: RegistryDeps): ToolInfo[] {
  return allTools(deps).map(t => ({ name: t.name, description: t.description.split('\n')[0], category: t.category, source: t.source, schema: t.parameters, server: t.server }))
}

export function findTool(tools: ToolDef[], name: string): ToolDef | undefined {
  return tools.find(t => t.name === name) ?? tools.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? tools.find(t => t.name.replace(/[-_]/g, '').toLowerCase() === name.replace(/[-_]/g, '').toLowerCase())
}
