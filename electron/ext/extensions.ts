import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { app } from 'electron'
import { z } from 'zod'
import type { BundledExtension, ExtensionInfo, ExtensionManifest, ExtensionsApi, RegistryEntry } from '../../shared/ext'
import type { CommandInfo } from '../../shared/ai'
import type { HookEvent } from '../../shared/settings'
import { THEMES, themeById, type ThemeDef } from '../../shared/themes'
import { settings } from '../services/settings'
import { workspace } from '../services/workspace'
import { dataDir, dataPath, PROJECT_DIR } from '../services/paths'
import { bus, emit } from '../services/events'
import { log } from '../services/log'
import { run, defaultShell, killTree } from '../services/proc'
import { registerExternalTools, unregisterExternalTools } from '../ai/tools/registry'
import { defineRawTool, type ToolDef } from '../ai/tools/types'
import { onHook, type HookPayload, type HookResult } from '../ai/hooks'
import { registerCommandSource, registerSkillRoots, expandCommand } from '../ai/knowledge'
import { httpFetch } from '../ai/providers/http'
import { truncateOutput } from '../ai/tools/util'
import { spawn } from 'node:child_process'

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/i, 'id may only contain letters, numbers, dots, dashes and underscores'),
  name: z.string().min(1), version: z.string().default('0.0.0'), description: z.string().optional(), author: z.string().optional(), homepage: z.string().optional(),
  main: z.string().optional(), permissions: z.array(z.string()).optional(), contributes: z.any().optional()
})

interface Loaded {
  info: ExtensionInfo
  unsubs: (() => void)[]
  deactivate?: () => void | Promise<void>
  tools: ToolDef[]
  commands: (CommandInfo & { run?: (args: string) => string | Promise<string> })[]
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

function shellQuote(kind: string, v: string): string {
  if (kind === 'powershell') return `'${v.replace(/'/g, "''")}'`
  if (kind === 'cmd') return `"${v.replace(/"/g, '""')}"`
  return `'${v.replace(/'/g, `'\\''`)}'`
}

/** Tool whose implementation is a shell command template, e.g. "node scripts/lint.js {{file}}". */
export function commandTool(def: { name: string; description: string; parameters?: Record<string, unknown>; command: string; timeoutMs?: number; cwd?: string }, category: 'custom' | 'plugin', source: ToolDef['source'], root: () => string | null): ToolDef {
  const params = def.parameters ?? { type: 'object', properties: {} }
  return defineRawTool({
    name: def.name, description: def.description, category, parameters: params, source, timeoutMs: (def.timeoutMs ?? 60_000) + 2000,
    describe: input => {
      const sh = defaultShell(settings.get().terminal.shell)
      const cmd = def.command.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => shellQuote(sh.kind, String((input as Record<string, unknown>)[k] ?? '')))
      return { title: def.name, plan: { cmd }, checks: [{ category, toolName: def.name, resources: [def.name], title: `Run custom tool ${def.name}`, detail: cmd }] }
    },
    async execute(_input, ctx, plan) {
      const sh = defaultShell(settings.get().terminal.shell)
      const cmd = (plan as { cmd: string }).cmd
      const r = await new Promise<{ out: string; code: number | null; timedOut: boolean }>(resolveP => {
        const child = spawn(sh.path, sh.args(cmd), { cwd: def.cwd ? resolve(root() ?? '.', def.cwd) : root() ?? undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = '', timedOut = false
        child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
        const t = setTimeout(() => { timedOut = true; killTree(child) }, def.timeoutMs ?? 60_000)
        ctx.signal.addEventListener('abort', () => killTree(child), { once: true })
        child.on('close', code => { clearTimeout(t); resolveP({ out, code, timedOut }) })
        child.on('error', e => { clearTimeout(t); resolveP({ out: e.message, code: -1, timedOut }) })
      })
      const t = await truncateOutput(r.out.replace(/\x1b\[[0-9;]*m/g, ''), { save: false })
      return { output: (t.text || '(no output)') + (r.timedOut ? '\n[timed out]' : r.code ? `\n[exit code ${r.code}]` : ''), isError: !!r.code || r.timedOut }
    }
  })
}

class ExtensionManager implements ExtensionsApi {
  private loaded = new Map<string, Loaded>()
  private customKeys = new Set<string>()
  private customList: { name: string; description: string; source: string; error?: string }[] = []
  private started = false

  init(): void {
    if (this.started) return
    this.started = true
    registerCommandSource(() => [...this.loaded.values()].filter(l => l.info.active).flatMap(l => l.commands.map(c => ({ name: c.name, description: c.description, template: c.template, agent: c.agent, source: 'extension' as const, hint: c.hint }))))
    registerSkillRoots(() => [...this.loaded.values()].filter(l => l.info.active).map(l => l.info.dir))
    bus.on('workspace:changed', () => { void this.reload() })
    bus.on('fs:changed:internal', (events: { path: string }[]) => { if (events.some(e => e.path.includes(`${PROJECT_DIR}${process.platform === 'win32' ? '\\' : '/'}tools`))) void this.loadCustomTools() })
    void this.reload()
  }

  private dirs(): { dir: string; scope: 'global' | 'project' }[] {
    const out: { dir: string; scope: 'global' | 'project' }[] = [{ dir: dataDir('extensions'), scope: 'global' }]
    if (workspace.root) out.push({ dir: join(workspace.root, PROJECT_DIR, 'extensions'), scope: 'project' })
    return out
  }

  bundledDir(): string | null {
    const cands = [join(process.resourcesPath ?? '', 'extensions'), join(app.getAppPath(), 'extensions'), join(__dirname, '..', 'extensions')]
    return cands.find(existsSync) ?? null
  }

  private readManifest(dir: string): ExtensionManifest {
    const file = join(dir, 'tgg-extension.json')
    if (!existsSync(file)) throw new Error('tgg-extension.json not found')
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    return parsed.data as ExtensionManifest
  }

  private async deactivate(id: string): Promise<void> {
    const l = this.loaded.get(id)
    if (!l) return
    for (const u of l.unsubs) { try { u() } catch { /* ignore */ } }
    try { await l.deactivate?.() } catch { /* ignore */ }
    unregisterExternalTools(`ext:${id}`)
    this.loaded.delete(id)
  }

  private async activate(dir: string, scope: 'global' | 'project'): Promise<void> {
    let manifest: ExtensionManifest
    try { manifest = this.readManifest(dir) } catch (e) {
      const id = basename(dir)
      this.loaded.set(id, { info: { id, manifest: { id, name: id, version: '?' }, scope, dir, enabled: false, active: false, error: (e as Error).message, tools: [], commands: [], themes: [] }, unsubs: [], tools: [], commands: [] })
      return
    }
    const enabled = !settings.get().extensions.disabled.includes(manifest.id)
    const l: Loaded = { info: { id: manifest.id, manifest, scope, dir, enabled, active: false, tools: [], commands: [], themes: (manifest.contributes?.themes ?? []).map(t => t.id) }, unsubs: [], tools: [], commands: [] }
    this.loaded.set(manifest.id, l)
    if (!enabled) return
    try {
      for (const t of manifest.contributes?.tools ?? []) {
        l.tools.push(commandTool({ ...t, name: `${safe(manifest.id)}__${safe(t.name)}`.slice(0, 64), cwd: undefined }, 'plugin', 'plugin', () => workspace.root))
      }
      for (const c of manifest.contributes?.commands ?? []) l.commands.push({ name: c.name, description: c.description, template: c.template, agent: c.agent, source: 'extension' })
      if (manifest.contributes?.mcpServers) { /* surfaced in the MCP view as suggestions; not auto-started */ }
      if (manifest.main) {
        const req = createRequire(join(dir, 'index.js'))
        const mainPath = resolve(dir, manifest.main)
        delete req.cache[req.resolve(mainPath)]
        const mod = req(mainPath) as { activate?: (api: unknown) => void | Promise<void>; deactivate?: () => void }
        const api = {
          id: manifest.id, version: manifest.version, dir,
          tools: { register: (d: { name: string; description: string; parameters?: Record<string, unknown>; readOnly?: boolean; execute: (args: Record<string, unknown>, ctx: { root: string | null; signal: AbortSignal }) => Promise<string | { output: string; isError?: boolean }> | string | { output: string; isError?: boolean } }) => {
            l.tools.push(defineRawTool({
              name: `${safe(manifest.id)}__${safe(d.name)}`.slice(0, 64), description: d.description, category: 'plugin', parameters: d.parameters ?? { type: 'object', properties: {} }, source: 'plugin', readOnly: d.readOnly,
              describe: i => ({ title: `${manifest.name}: ${d.name}`, checks: [{ category: 'plugin', toolName: d.name, resources: [`${manifest.id}:${d.name}`], title: `${manifest.name} → ${d.name}`, detail: JSON.stringify(i).slice(0, 300) }] }),
              async execute(input, ctx) { const r = await d.execute(input as Record<string, unknown>, { root: workspace.root, signal: ctx.signal }); return typeof r === 'string' ? { output: r } : r }
            }))
          } },
          commands: { register: (d: { name: string; description: string; template?: string; run?: (args: string) => string | Promise<string>; agent?: string }) => { l.commands.push({ name: d.name, description: d.description, template: d.template ?? '$ARGUMENTS', agent: d.agent, source: 'extension', run: d.run }) } },
          hooks: { on: (ev: HookEvent, fn: (p: HookPayload) => HookResult | Promise<HookResult>) => { l.unsubs.push(onHook(ev, fn)) } },
          workspace: { get root() { return workspace.root }, readFile: (p: string) => fsp.readFile(resolve(workspace.root ?? '.', p), 'utf8'), writeFile: (p: string, c: string) => fsp.writeFile(resolve(workspace.root ?? '.', p), c) },
          shell: { run: (cmd: string, opts?: { cwd?: string; timeoutMs?: number }) => run(defaultShell().path, defaultShell().args(cmd), { cwd: opts?.cwd ?? workspace.root ?? undefined, timeoutMs: opts?.timeoutMs ?? 30_000 }) },
          log: { info: (m: string) => log.info(`ext:${manifest.id}`, m), warn: (m: string) => log.warn(`ext:${manifest.id}`, m), error: (m: string) => log.error(`ext:${manifest.id}`, m) },
          notify: (message: string) => emit('app:notify', { message, level: 'info', source: manifest.name })
        }
        await mod.activate?.(api)
        l.deactivate = mod.deactivate
      }
      registerExternalTools(`ext:${manifest.id}`, l.tools)
      l.info.tools = l.tools.map(t => t.name); l.info.commands = l.commands.map(c => c.name); l.info.active = true
    } catch (e) {
      l.info.error = (e as Error).message
      log.error('ext', `${manifest.id}: ${(e as Error).stack ?? e}`)
      await this.deactivate(manifest.id)
      this.loaded.set(manifest.id, l)
    }
  }

  async reload(): Promise<void> {
    for (const id of [...this.loaded.keys()]) await this.deactivate(id)
    for (const { dir, scope } of this.dirs()) {
      let entries: string[] = []
      try { entries = await fsp.readdir(dir) } catch { continue }
      for (const e of entries) { const d = join(dir, e); if (existsSync(join(d, 'tgg-extension.json'))) await this.activate(d, scope) }
    }
    await this.loadCustomTools()
    emit('ext:changed', undefined)
  }

  // ───────────── project custom tools (.tgg/tools) ─────────────
  async loadCustomTools(): Promise<void> {
    for (const k of this.customKeys) unregisterExternalTools(k)
    this.customKeys.clear(); this.customList = []
    const root = workspace.root
    const dirs = [dataPath('tools'), ...(root ? [join(root, PROJECT_DIR, 'tools')] : [])]
    const defs: ToolDef[] = []
    for (const dir of dirs) {
      let files: string[] = []
      try { files = await fsp.readdir(dir) } catch { continue }
      for (const f of files) {
        const full = join(dir, f)
        try {
          if (f.endsWith('.json')) {
            const j = JSON.parse(await fsp.readFile(full, 'utf8')) as { name: string; description: string; parameters?: Record<string, unknown>; command: string; timeoutMs?: number; cwd?: string }
            if (!j.name || !j.command) throw new Error('"name" and "command" are required')
            defs.push(commandTool({ ...j, name: safe(j.name) }, 'custom', 'custom', () => root))
            this.customList.push({ name: safe(j.name), description: j.description, source: full })
          } else if (/\.(c?js)$/.test(f)) {
            const req = createRequire(full)
            delete req.cache[req.resolve(full)]
            const mod = req(full) as unknown
            const list = (Array.isArray(mod) ? mod : [(mod as { default?: unknown }).default ?? mod]) as { name: string; description: string; parameters?: Record<string, unknown>; execute: (a: Record<string, unknown>, ctx: { root: string | null; signal: AbortSignal }) => Promise<string | { output: string; isError?: boolean }> }[]
            for (const d of list) {
              defs.push(defineRawTool({
                name: safe(d.name), description: d.description, category: 'custom', parameters: d.parameters ?? { type: 'object', properties: {} }, source: 'custom',
                describe: i => ({ title: d.name, checks: [{ category: 'custom', toolName: d.name, resources: [d.name], title: `Run custom tool ${d.name}`, detail: JSON.stringify(i).slice(0, 300) }] }),
                async execute(input, ctx) { const r = await d.execute(input as Record<string, unknown>, { root, signal: ctx.signal }); return typeof r === 'string' ? { output: r } : r }
              }))
              this.customList.push({ name: safe(d.name), description: d.description, source: full })
            }
          }
        } catch (e) { this.customList.push({ name: f, description: '', source: full, error: (e as Error).message }) }
      }
    }
    if (defs.length) { registerExternalTools('custom', defs); this.customKeys.add('custom') }
  }

  // ───────────── API ─────────────
  async list(): Promise<ExtensionInfo[]> { return [...this.loaded.values()].map(l => l.info) }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const dis = new Set(settings.get().extensions.disabled)
    if (enabled) dis.delete(id); else dis.add(id)
    settings.setSection('extensions', { ...settings.get().extensions, disabled: [...dis] })
    await this.reload()
  }

  private async installDir(src: string, scope: 'global' | 'project'): Promise<ExtensionInfo> {
    const manifest = this.readManifest(src)
    const base = scope === 'project' && workspace.root ? join(workspace.root, PROJECT_DIR, 'extensions') : dataDir('extensions')
    const dest = join(base, manifest.id)
    if (resolve(src) !== resolve(dest)) {
      await fsp.rm(dest, { recursive: true, force: true })
      await fsp.mkdir(base, { recursive: true })
      await fsp.cp(src, dest, { recursive: true, filter: s => !/node_modules[\\/]\.cache|\.git([\\/]|$)/.test(s) })
    }
    await this.reload()
    const info = this.loaded.get(manifest.id)?.info
    if (!info) throw new Error('Extension failed to load')
    return info
  }

  installFromFolder(path: string, scope: 'global' | 'project' = 'global') { return this.installDir(path, scope) }

  async installFromZip(path: string): Promise<ExtensionInfo> {
    const data = new Uint8Array(await fsp.readFile(path))
    const files = unzipSync(data)
    const tmp = join(dataDir('tmp'), `ext-${Date.now()}`)
    await fsp.mkdir(tmp, { recursive: true })
    let rootPrefix = ''
    const names = Object.keys(files)
    const manifestName = names.find(n => /(^|\/)tgg-extension\.json$/.test(n))
    if (!manifestName) throw new Error('The archive does not contain a tgg-extension.json')
    rootPrefix = manifestName.slice(0, manifestName.length - 'tgg-extension.json'.length)
    for (const n of names) {
      if (!n.startsWith(rootPrefix) || n.endsWith('/')) continue
      const rel = n.slice(rootPrefix.length)
      if (rel.split('/').includes('..')) continue
      const out = join(tmp, rel)
      await fsp.mkdir(dirname(out), { recursive: true })
      await fsp.writeFile(out, files[n])
    }
    try { return await this.installDir(tmp, 'global') } finally { await fsp.rm(tmp, { recursive: true, force: true }) }
  }

  async installFromUrl(url: string): Promise<ExtensionInfo> {
    if (!/^https?:\/\//.test(url)) throw new Error('Enter an http(s) URL to a .zip extension')
    const res = await httpFetch(url)
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    const tmp = join(dataDir('tmp'), `dl-${Date.now()}.zip`)
    await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()))
    try { return await this.installFromZip(tmp) } finally { await fsp.rm(tmp, { force: true }) }
  }

  async bundled(): Promise<BundledExtension[]> {
    const dir = this.bundledDir()
    if (!dir) return []
    const out: BundledExtension[] = []
    for (const e of await fsp.readdir(dir)) {
      try { const m = this.readManifest(join(dir, e)); out.push({ id: m.id, name: m.name, description: m.description ?? '', version: m.version, installed: this.loaded.has(m.id) }) } catch { /* skip */ }
    }
    return out
  }

  async installBundled(id: string): Promise<ExtensionInfo> {
    const dir = this.bundledDir()
    if (!dir) throw new Error('No bundled extensions available')
    for (const e of await fsp.readdir(dir)) { try { if (this.readManifest(join(dir, e)).id === id) return this.installDir(join(dir, e), 'global') } catch { /* skip */ } }
    throw new Error(`Bundled extension "${id}" not found`)
  }

  async uninstall(id: string): Promise<void> {
    const l = this.loaded.get(id)
    if (!l) return
    await this.deactivate(id)
    await fsp.rm(l.info.dir, { recursive: true, force: true })
    this.loaded.delete(id)
    await this.reload()
  }

  async registry(): Promise<RegistryEntry[]> {
    const url = settings.get().extensions.registryUrl
    if (!url) return []
    const res = await httpFetch(url)
    if (!res.ok) throw new Error(`Registry returned HTTP ${res.status}`)
    const j = await res.json() as { extensions?: RegistryEntry[] } | RegistryEntry[]
    return Array.isArray(j) ? j : j.extensions ?? []
  }

  async themes(): Promise<ThemeDef[]> {
    const out: ThemeDef[] = []
    const add = (raw: Partial<ThemeDef> & { id: string; name: string; kind: 'light' | 'dark'; base?: string }) => {
      const base = themeById(raw.base ?? (raw.kind === 'light' ? 'tgg-light' : 'tgg-dark'))
      out.push({ id: raw.id, name: raw.name, kind: raw.kind, description: raw.description, ui: { ...base.ui, ...(raw.ui ?? {}) }, syntax: { ...base.syntax, ...(raw.syntax ?? {}) }, monaco: raw.monaco })
    }
    for (const l of this.loaded.values()) if (l.info.active) for (const t of l.info.manifest.contributes?.themes ?? []) { try { add(t) } catch { /* bad theme */ } }
    try {
      for (const f of await fsp.readdir(dataPath('themes'))) if (f.endsWith('.json')) { try { add(JSON.parse(await fsp.readFile(join(dataPath('themes'), f), 'utf8'))) } catch { /* skip */ } }
    } catch { /* none */ }
    return out.filter(t => !THEMES.some(b => b.id === t.id))
  }

  async customTools() { return this.customList }

  async runCommand(name: string, args: string): Promise<string | null> {
    for (const l of this.loaded.values()) { const c = l.commands.find(x => x.name === name); if (c) return c.run ? await c.run(args) : expandCommand(c.template, args) }
    return null
  }

  async scaffold(name: string, scope: 'global' | 'project'): Promise<string> {
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id) throw new Error('Enter a name')
    const base = scope === 'project' && workspace.root ? join(workspace.root, PROJECT_DIR, 'extensions') : dataDir('extensions')
    const dir = join(base, id)
    if (existsSync(dir)) throw new Error(`"${id}" already exists`)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'tgg-extension.json'), JSON.stringify({ id, name, version: '0.1.0', description: 'My extension', main: 'index.js', contributes: { commands: [{ name: `${id}-hello`, description: 'Say hello', template: 'Say hello to $ARGUMENTS in a creative way.' }] } }, null, 2))
    await fsp.writeFile(join(dir, 'index.js'), `// ${name} – a TGGAGS IDE extension. Runs in the main process.\nexports.activate = function activate(tgg) {\n  tgg.tools.register({\n    name: 'echo',\n    description: 'Echo back a message (example tool).',\n    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },\n    readOnly: true,\n    async execute(args) { return 'You said: ' + args.message }\n  })\n  tgg.hooks.on('file.edited', p => { tgg.log.info('edited ' + p.path) })\n}\n`)
    await this.reload()
    return dir
  }
}

export const extensions = new ExtensionManager()
