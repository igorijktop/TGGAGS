import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AiApi, AgentsApi, CommandsApi, MemoryApi, PermissionsApi, ProvidersApi, SkillsApi, ToolsApi } from '../../shared/api'
import type { ContextItem, Message, Session } from '../../shared/ai'
import { defaultPermissionRules, type AgentConfig } from '../../shared/settings'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { credentials } from '../services/credentials'
import { dataPath, PROJECT_DIR } from '../services/paths'
import { uid } from '../services/storage'
import { runtime } from './runtime'
import { sessions, metaOf, messageText } from './sessions'
import { snapshots } from './snapshots'
import { loadAgents } from './agents'
import { estimateTokens, IMAGE_TOKENS } from './context'
import { BUILTIN_COMMANDS, expandCommand, listCommands, listSkills, readMemory, writeMemory } from './knowledge'
import { stringifyFrontmatter } from './frontmatter'
import { toolInfo } from './tools/registry'
import { discoverModels, providerKeyName, testProvider } from './providers'
import { isImagePath } from '../../shared/languages'
import { basename } from 'node:path'

function sessionToMarkdown(s: Session): string {
  const lines = [`# ${s.title}`, '', `_Agent: ${s.agent} · ${new Date(s.createdAt).toLocaleString()}_`, '']
  const render = (m: Message) => {
    if (m.notice) return
    if (m.role === 'user') { const t = messageText(m); if (t.trim()) lines.push(`## 🧑 User\n\n${t}\n`) }
    else {
      lines.push('## 🤖 Assistant\n')
      for (const p of m.parts) {
        if (p.type === 'text') lines.push(p.text + '\n')
        else if (p.type === 'tool') lines.push(`<details><summary>🔧 ${p.name} – ${p.title ?? p.state}</summary>\n\n\`\`\`\n${(p.output ?? '').slice(0, 3000)}\n\`\`\`\n</details>\n`)
      }
    }
  }
  s.messages.forEach(render)
  return lines.join('\n')
}

const rootOrNull = () => workspace.root

export const aiApi: AiApi = {
  send: req => runtime.send(req),
  async abort(id) { runtime.abort(id) },
  async running() { return runtime.runningIds() },
  async pending() { return runtime.pending() },
  async answerPermission(r) { runtime.answerPermission(r) },
  async answerQuestion(r) { runtime.answerQuestion(r) },
  compact: id => runtime.compactSession(id),
  sessions: {
    async list(projectOnly = true) { return sessions.list(projectOnly ? rootOrNull() : undefined) },
    async get(id) { return sessions.get(id) },
    async create(opts) {
      const root = rootOrNull()
      const s = sessions.create({ projectRoot: root, agent: opts?.agent ?? settings.get().ai.defaultAgent })
      runtime.emitEvent({ type: 'session', session: metaOf(s) })
      return s
    },
    async delete(id) { runtime.abort(id); await sessions.delete(id) },
    async rename(id, title) { const s = sessions.get(id); if (s) { s.title = title; s.titled = true; sessions.save(s); runtime.emitEvent({ type: 'session', session: metaOf(s) }) } },
    async fork(id, mid) { const s = sessions.fork(id, mid); if (s) runtime.emitEvent({ type: 'session', session: metaOf(s) }); return s },
    async exportMarkdown(id) { const s = sessions.get(id); return s ? sessionToMarkdown(s) : '' },
    async setConfig(id, cfg) {
      const s = sessions.get(id)
      if (!s) return
      if (cfg.agent) s.agent = cfg.agent
      if (cfg.model !== undefined) s.model = cfg.model
      if (cfg.mode) s.mode = cfg.mode
      if (cfg.reasoning) s.reasoning = cfg.reasoning
      sessions.save(s)
    },
    async stats() { return sessions.stats() },
    async truncateAt(id, messageId) {
      if (runtime.isRunning(id)) throw new Error('Stop the current run first.')
      const s = sessions.get(id)
      if (!s) return null
      const i = s.messages.findIndex(m => m.id === messageId)
      if (i >= 0) { s.messages = s.messages.slice(0, i); if (s.compactedUpTo && !s.messages.some(m => m.id === s.compactedUpTo)) s.compactedUpTo = undefined; sessions.saveNow(s) }
      return s
    }
  },
  changes: {
    async list(id) { return snapshots.summary(id, rootOrNull()) },
    async undoFromTurn(id, turnId) { const r = await snapshots.revertFromTurn(id, turnId); runtime.emitEvent({ type: 'changes', sessionId: id, changes: await snapshots.summary(id, rootOrNull()) }); return r },
    async undoLastTurn(id) { const r = await snapshots.revertLastTurn(id); runtime.emitEvent({ type: 'changes', sessionId: id, changes: await snapshots.summary(id, rootOrNull()) }); return r },
    async redo(id) { const r = await snapshots.redo(id); runtime.emitEvent({ type: 'changes', sessionId: id, changes: await snapshots.summary(id, rootOrNull()) }); return r },
    async revertFile(id, path) { const ok = await snapshots.revertFile(id, path); runtime.emitEvent({ type: 'changes', sessionId: id, changes: await snapshots.summary(id, rootOrNull()) }); return ok },
    async accept(id) { await snapshots.clear(id); runtime.emitEvent({ type: 'changes', sessionId: id, changes: [] }) },
    canRedo: id => snapshots.canRedo(id)
  },
  context: {
    async get(id) { return runtime.contextFor(id) },
    async setItems(id, items) { runtime.updateContextItems(id, items); return runtime.contextFor(id) },
    async describe(path): Promise<ContextItem> {
      let isDir = false, tokens = 0
      try {
        const st = await fsp.stat(path)
        isDir = st.isDirectory()
        tokens = isDir ? 400 : isImagePath(path) ? IMAGE_TOKENS : Math.min(settings.get().context.maxFileTokens, Math.ceil(st.size / 3.6))
      } catch { /* missing */ }
      const root = rootOrNull()
      return { id: uid('ctx-'), kind: isDir ? 'folder' : isImagePath(path) ? 'image' : 'file', label: root && path.startsWith(root) ? path.slice(root.length + 1).replace(/\\/g, '/') : basename(path), path, tokens, enabled: true, pinned: false, priority: 4, auto: false }
    },
    async estimate(text) { return estimateTokens(text) }
  },
  async complete(system, user, opts) {
    const cand = await runtime.helperModel(settings.get().ai.defaultModel)
    if (!cand) throw new Error('No model configured. Add one in Settings → Models.')
    return runtime.oneShot(cand, system, user, undefined, { maxTokens: opts?.maxTokens ?? 1500 })
  }
}

export const agentsApi: AgentsApi = {
  list: () => loadAgents(rootOrNull()),
  async save(agent) {
    const list = settings.get().agents.filter(a => a.id !== agent.id)
    const { source, filePath, ...clean } = agent
    void source; void filePath
    settings.update({ agents: [...list, { ...clean, builtin: undefined }] })
  },
  async remove(id) { settings.update({ agents: settings.get().agents.filter(a => a.id !== id) }) },
  async writeFile(agent, scope) {
    const root = rootOrNull()
    const dir = scope === 'project' ? (root ? join(root, PROJECT_DIR, 'agents') : null) : dataPath('agents')
    if (!dir) throw new Error('Open a project to save project-level agents.')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, `${agent.id}.md`)
    const fm: Record<string, unknown> = { name: agent.name, description: agent.description, mode: agent.mode, tools: agent.tools.join(', ') }
    if (agent.model) fm.model = `${agent.model.provider}/${agent.model.model}`
    if (agent.temperature !== undefined) fm.temperature = agent.temperature
    if (agent.reasoning) fm.reasoning = agent.reasoning
    if (agent.color) fm.color = agent.color
    if (agent.maxSteps) fm.maxSteps = agent.maxSteps
    await fsp.writeFile(file, stringifyFrontmatter(fm, agent.prompt))
    return file
  }
}

const skillDeps = () => ({ skills: () => [], subagents: () => [] })
export const toolsApi: ToolsApi = { async list() { return toolInfo(skillDeps()) } }

export const skillsApi: SkillsApi = {
  list: () => listSkills(rootOrNull()),
  async read(name) { const s = (await listSkills(rootOrNull())).find(x => x.name === name); return s ? fsp.readFile(s.path, 'utf8') : '' },
  async create(name, description, body, scope) {
    const root = rootOrNull()
    const base = scope === 'project' ? (root ? join(root, PROJECT_DIR, 'skills') : null) : dataPath('skills')
    if (!base) throw new Error('Open a project to create project skills.')
    const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!safe) throw new Error('Invalid skill name')
    await fsp.mkdir(join(base, safe), { recursive: true })
    const file = join(base, safe, 'SKILL.md')
    await fsp.writeFile(file, stringifyFrontmatter({ name: safe, description }, body))
    return file
  },
  async remove(name) { const s = (await listSkills(rootOrNull())).find(x => x.name === name); if (s) await fsp.rm(join(s.path, '..'), { recursive: true, force: true }) }
}

export const commandsApi: CommandsApi = {
  list: () => listCommands(rootOrNull()),
  async expand(name, args) {
    const c = (await listCommands(rootOrNull())).find(x => x.name === name)
    return c ? { text: expandCommand(c.template, args), agent: c.agent } : null
  },
  async save(name, description, template, scope) {
    const root = rootOrNull()
    const dir = scope === 'project' ? (root ? join(root, PROJECT_DIR, 'commands') : null) : dataPath('commands')
    if (!dir) throw new Error('Open a project to create project commands.')
    const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    if (BUILTIN_COMMANDS.some(c => c.name === safe) && false) throw new Error('reserved')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, `${safe}.md`)
    await fsp.writeFile(file, stringifyFrontmatter({ description }, template))
    return file
  }
}

export const memoryApi: MemoryApi = {
  get: () => readMemory(rootOrNull()),
  set: (scope, text) => writeMemory(rootOrNull(), scope, text)
}

export const permissionsApi: PermissionsApi = { async defaults() { return defaultPermissionRules() } }

export const providersApi: ProvidersApi = {
  test: (cfg, key) => testProvider(cfg, key),
  discover: (cfg, key) => discoverModels(cfg, key),
  async setKey(id, key) { credentials.set(providerKeyName(id), key.trim()) },
  async keyStatus() {
    const out: Record<string, 'stored' | 'env' | 'none'> = {}
    for (const p of settings.get().providers) out[p.id] = credentials.has(providerKeyName(p.id)) ? 'stored' : p.apiKeyEnv && process.env[p.apiKeyEnv] ? 'env' : 'none'
    return out
  }
}

export type { AgentConfig }
