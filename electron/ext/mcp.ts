import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { McpApi, McpCatalogEntry, McpServerState } from '../../shared/ext'
import type { McpServerConfig } from '../../shared/settings'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { emit, bus } from '../services/events'
import { log } from '../services/log'
import { PROJECT_DIR } from '../services/paths'
import { registerExternalTools, unregisterExternalTools } from '../ai/tools/registry'
import { defineRawTool, type ToolDef } from '../ai/tools/types'
import { httpFetch } from '../ai/providers/http'

interface Live { client: Client; state: McpServerState }

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

export const MCP_CATALOG: McpCatalogEntry[] = [
  { id: 'filesystem', name: 'Filesystem', category: 'Files', description: 'Read and write files in folders you allow.', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, needs: 'Node.js (npx)', homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'memory', name: 'Knowledge-graph memory', category: 'Memory', description: 'Persistent memory as a knowledge graph.', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, needs: 'Node.js (npx)' },
  { id: 'sequential-thinking', name: 'Sequential thinking', category: 'Reasoning', description: 'Structured step-by-step problem solving.', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }, needs: 'Node.js (npx)' },
  { id: 'github', name: 'GitHub', category: 'Dev', description: 'Issues, pull requests and repositories (needs a token).', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } }, needs: 'Node.js + GitHub token' },
  { id: 'playwright', name: 'Playwright browser', category: 'Browser', description: 'Control a real browser: navigate, click, screenshot, test web apps.', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, needs: 'Node.js (npx)' },
  { id: 'context7', name: 'Context7 docs', category: 'Docs', description: 'Up-to-date library documentation for any package.', config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, needs: 'Node.js (npx)' },
  { id: 'fetch', name: 'Fetch', category: 'Web', description: 'Fetch web pages and convert them to Markdown.', config: { command: 'uvx', args: ['mcp-server-fetch'] }, needs: 'Python uv (uvx)' },
  { id: 'git', name: 'Git', category: 'Dev', description: 'Read and manipulate Git repositories.', config: { command: 'uvx', args: ['mcp-server-git'] }, needs: 'Python uv (uvx)' },
  { id: 'sqlite', name: 'SQLite', category: 'Data', description: 'Query and analyse SQLite databases.', config: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', './data.db'] }, needs: 'Python uv (uvx)' },
  { id: 'brave-search', name: 'Brave Search', category: 'Web', description: 'Web search via the Brave Search API (needs an API key).', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' } }, needs: 'Node.js + Brave API key' },
  { id: 'puppeteer', name: 'Puppeteer', category: 'Browser', description: 'Browser automation and screenshots.', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] }, needs: 'Node.js (npx)' }
]

class McpManager implements McpApi {
  private live = new Map<string, Live>()
  private states = new Map<string, McpServerState>()
  private started = false

  init(): void {
    if (this.started) return
    this.started = true
    bus.on('workspace:changed', () => { void this.reload() })
    bus.on('settings:changed', () => { void this.syncSettings() })
  }

  private async projectConfigs(): Promise<Record<string, McpServerConfig>> {
    const root = workspace.root
    if (!root) return {}
    const out: Record<string, McpServerConfig> = {}
    for (const f of [join(root, '.mcp.json'), join(root, PROJECT_DIR, 'mcp.json')]) {
      try {
        const j = JSON.parse(await fsp.readFile(f, 'utf8')) as { mcpServers?: Record<string, McpServerConfig>; servers?: Record<string, McpServerConfig> }
        Object.assign(out, j.mcpServers ?? j.servers ?? {})
      } catch { /* missing */ }
    }
    return out
  }

  private async allConfigs(): Promise<Map<string, { config: McpServerConfig; scope: 'global' | 'project' }>> {
    const m = new Map<string, { config: McpServerConfig; scope: 'global' | 'project' }>()
    for (const [n, c] of Object.entries(settings.get().mcp.servers)) m.set(n, { config: c, scope: 'global' })
    for (const [n, c] of Object.entries(await this.projectConfigs())) m.set(n, { config: c, scope: 'project' })
    return m
  }

  private publish(): void { emit('mcp:changed', [...this.states.values()].map(s => ({ ...s, logs: s.logs.slice(-50) }))) }

  async reload(): Promise<void> {
    for (const name of [...this.live.keys()]) await this.stop(name)
    this.states.clear()
    await this.syncSettings()
  }

  private async syncSettings(): Promise<void> {
    const cfgs = await this.allConfigs()
    for (const name of [...this.states.keys()]) if (!cfgs.has(name)) { await this.stop(name); this.states.delete(name) }
    for (const [name, { config, scope }] of cfgs) {
      const prev = this.states.get(name)
      const changed = prev && JSON.stringify(prev.config) !== JSON.stringify(config)
      if (prev && !changed) { prev.scope = scope; continue }
      if (prev) await this.stop(name)
      this.states.set(name, { name, config, scope, status: config.enabled === false ? 'disabled' : 'stopped', tools: [], resources: [], logs: prev?.logs ?? [] })
      if (config.enabled !== false) void this.start(name)
    }
    this.publish()
  }

  private async start(name: string): Promise<void> {
    const state = this.states.get(name)
    if (!state || this.live.has(name)) return
    const cfg = state.config
    state.status = 'connecting'; state.error = undefined; this.publish()
    const client = new Client({ name: 'tggags-ide', version: '1.0.0' }, { capabilities: {} })
    try {
      let transport
      const type = cfg.type ?? (cfg.url ? 'http' : 'stdio')
      if (type === 'stdio') {
        if (!cfg.command) throw new Error('No command configured')
        const t = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), ...(cfg.env ?? {}) }, cwd: cfg.cwd ?? workspace.root ?? undefined, stderr: 'pipe' })
        t.stderr?.on('data', d => { state.logs.push(String(d).trimEnd()); if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300) })
        transport = t
      } else {
        if (!cfg.url) throw new Error('No URL configured')
        const opts = { requestInit: { headers: cfg.headers ?? {} }, fetch: httpFetch as unknown as typeof fetch }
        transport = type === 'sse' ? new SSEClientTransport(new URL(cfg.url), opts) : new StreamableHTTPClientTransport(new URL(cfg.url), opts)
      }
      client.onclose = () => { if (this.live.get(name)?.client === client) { this.live.delete(name); unregisterExternalTools(`mcp:${name}`); const st = this.states.get(name); if (st && st.status === 'connected') { st.status = 'error'; st.error = 'Connection closed' } this.publish() } }
      await Promise.race([client.connect(transport), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('Timed out connecting (30s). Is the command installed? Check the logs.')), 30_000))])
      const listed = await client.listTools()
      const defs: ToolDef[] = listed.tools.map(t => {
        const fullName = `mcp__${safe(name)}__${safe(t.name)}`.slice(0, 64)
        const params = (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        if (!params.type) params.type = 'object'
        return defineRawTool({
          name: fullName, description: `[${name}] ${t.description ?? t.name}`, category: 'mcp', parameters: params, source: 'mcp', server: name, timeoutMs: (cfg.timeoutMs ?? 60_000) + 5000,
          describe: (input) => ({ title: `${name}: ${t.name}`, checks: [{ category: 'mcp', toolName: fullName, resources: [fullName], title: `${name} → ${t.name}`, detail: JSON.stringify(input).slice(0, 400) }] }),
          async execute(input, ctx) {
            const res = await client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { timeout: cfg.timeoutMs ?? 60_000, signal: ctx.signal })
            const texts: string[] = []
            const images: { mime: string; data: string }[] = []
            for (const c of (res.content as { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[]) ?? []) {
              if (c.type === 'text' && c.text) texts.push(c.text)
              else if (c.type === 'image' && c.data) images.push({ mime: c.mimeType ?? 'image/png', data: c.data })
              else if (c.type === 'resource' && c.resource) texts.push(c.resource.text ?? `[resource ${c.resource.uri}]`)
            }
            if (res.structuredContent && !texts.length) texts.push(JSON.stringify(res.structuredContent, null, 2))
            return { output: texts.join('\n') || (images.length ? `(${images.length} image result)` : '(no output)'), images, isError: !!res.isError }
          }
        })
      })
      registerExternalTools(`mcp:${name}`, defs)
      let resources: McpServerState['resources'] = []
      try { resources = (await client.listResources()).resources.map(r => ({ uri: r.uri, name: r.name, description: r.description })) } catch { /* not supported */ }
      state.tools = defs.map((d, i) => ({ name: listed.tools[i].name, fullName: d.name, description: listed.tools[i].description ?? '' }))
      state.resources = resources
      state.serverInfo = client.getServerVersion() as { name?: string; version?: string } | undefined
      state.status = 'connected'
      this.live.set(name, { client, state })
      log.info('mcp', `${name}: connected, ${defs.length} tools`)
    } catch (e) {
      state.status = 'error'; state.error = (e as Error).message
      log.warn('mcp', `${name}: ${state.error}`)
      try { await client.close() } catch { /* ignore */ }
    }
    this.publish()
  }

  private async stop(name: string): Promise<void> {
    const l = this.live.get(name)
    this.live.delete(name)
    unregisterExternalTools(`mcp:${name}`)
    if (l) { try { await l.client.close() } catch { /* ignore */ } }
  }

  // ───────────── API ─────────────
  async list(): Promise<McpServerState[]> { await this.syncSettings(); return [...this.states.values()].map(s => ({ ...s, logs: s.logs.slice(-80) })) }
  async restart(name: string): Promise<void> { await this.stop(name); await this.start(name) }
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const cfgs = await this.allConfigs()
    const e = cfgs.get(name)
    if (!e) return
    await this.writeConfig(name, { ...e.config, enabled }, e.scope)
  }
  private async writeConfig(name: string, config: McpServerConfig, scope: 'global' | 'project'): Promise<void> {
    if (scope === 'global') settings.update({ mcp: { servers: { ...settings.get().mcp.servers, [name]: config } } })
    else {
      const root = workspace.requireRoot()
      const f = join(root, PROJECT_DIR, 'mcp.json')
      let j: { mcpServers: Record<string, McpServerConfig> } = { mcpServers: {} }
      try { j = JSON.parse(await fsp.readFile(f, 'utf8')) } catch { /* new */ }
      j.mcpServers = { ...(j.mcpServers ?? {}), [name]: config }
      await fsp.mkdir(join(root, PROJECT_DIR), { recursive: true })
      await fsp.writeFile(f, JSON.stringify(j, null, 2))
    }
    await this.syncSettings()
  }
  async save(name: string, config: McpServerConfig, scope: 'global' | 'project'): Promise<void> {
    const clean = name.trim().replace(/\s+/g, '-')
    if (!clean) throw new Error('A server name is required')
    await this.writeConfig(clean, config, scope)
  }
  async remove(name: string): Promise<void> {
    const cfgs = await this.allConfigs()
    const e = cfgs.get(name)
    await this.stop(name)
    if (e?.scope === 'project') {
      const f = join(workspace.requireRoot(), PROJECT_DIR, 'mcp.json')
      try { const j = JSON.parse(await fsp.readFile(f, 'utf8')); delete j.mcpServers?.[name]; await fsp.writeFile(f, JSON.stringify(j, null, 2)) } catch { /* ignore */ }
    } else { const s = { ...settings.get().mcp.servers }; delete s[name]; settings.setSection('mcp', { servers: s }) }
    this.states.delete(name)
    await this.syncSettings()
  }
  async catalog(): Promise<McpCatalogEntry[]> { return MCP_CATALOG }
  async readResource(server: string, uri: string): Promise<string> {
    const l = this.live.get(server)
    if (!l) throw new Error(`MCP server "${server}" is not connected`)
    const r = await l.client.readResource({ uri })
    return (r.contents as { text?: string }[]).map(c => c.text ?? '').join('\n')
  }
  shutdown(): void { for (const n of [...this.live.keys()]) void this.stop(n) }
}

export const mcp = new McpManager()
