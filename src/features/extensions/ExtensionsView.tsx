import { useCallback, useEffect, useState } from 'react'
import { Boxes, Download, FolderOpen, Globe, Link2, Plus, Puzzle, RefreshCw, Server, Sparkles, Terminal, Trash2, Wrench, Zap, Slash, Package } from 'lucide-react'
import type { BundledExtension, ExtensionInfo, McpCatalogEntry, McpServerState, RegistryEntry } from '@shared/ext'
import type { CommandInfo, SkillInfo, ToolInfo } from '@shared/ai'
import type { McpServerConfig } from '@shared/settings'
import { api, onEvent } from '../../lib/api'
import { cn } from '../../lib/util'
import { Badge, Button, Collapsible, EmptyState, IconButton, Segmented, Spinner, Switch } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'

type Tab = 'installed' | 'mcp' | 'tools' | 'skills'

// ───────────── MCP form ─────────────
function McpForm({ close, initial }: { close(v?: unknown): void; initial?: { name: string; config: McpServerConfig } }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<'stdio' | 'http'>(initial?.config.type === 'http' || initial?.config.type === 'sse' ? 'http' : 'stdio')
  const [command, setCommand] = useState(initial?.config.command ? [initial.config.command, ...(initial.config.args ?? [])].join(' ') : '')
  const [url, setUrl] = useState(initial?.config.url ?? '')
  const [env, setEnv] = useState(Object.entries(initial?.config.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'))
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const hasRoot = useWorkspace(s => !!s.root)
  const save = async () => {
    if (!/^[\w-]+$/.test(name.trim())) { toast.warn('Use a short name with letters, numbers and dashes.'); return }
    const cfg: McpServerConfig = type === 'http' ? { type: 'http', url: url.trim(), enabled: true } : (() => { const [cmd, ...args] = command.trim().split(/\s+/); return { type: 'stdio' as const, command: cmd, args, enabled: true } })()
    const envObj = Object.fromEntries(env.split('\n').map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    if (Object.keys(envObj).length) cfg.env = envObj
    try { await api.mcp.save(name.trim(), cfg, scope); close(true) } catch (e) { toast.error((e as Error).message) }
  }
  return <div className="col gap12" style={{ minWidth: 0 }}>
    <label className="field"><span className="field-label">Name</span><input className="input" value={name} autoFocus onChange={e => setName(e.target.value)} placeholder="github" disabled={!!initial} /></label>
    <div className="field"><span className="field-label">How it runs</span><Segmented<'stdio' | 'http'> value={type} options={[{ value: 'stdio', label: 'Program on this computer' }, { value: 'http', label: 'Remote URL' }]} onChange={setType} /></div>
    {type === 'stdio' ? <label className="field"><span className="field-label">Command</span><input className="input mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem ." /><span className="field-hint">Needs the program (for example Node.js for npx) to be installed.</span></label>
      : <label className="field"><span className="field-label">Server URL</span><input className="input mono" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>}
    <label className="field"><span className="field-label">Environment variables (one KEY=value per line)</span><textarea className="textarea mono" rows={3} value={env} onChange={e => setEnv(e.target.value)} style={{ fontSize: 12 }} /></label>
    {hasRoot && <div className="field"><span className="field-label">Available in</span><Segmented<'global' | 'project'> value={scope} options={[{ value: 'global', label: 'All projects' }, { value: 'project', label: 'This project only' }]} onChange={setScope} /></div>}
    <div className="row gap8" style={{ justifyContent: 'flex-end' }}><Button variant="ghost" onClick={() => close()}>Cancel</Button><Button variant="primary" disabled={!name.trim() || (type === 'stdio' ? !command.trim() : !url.trim())} onClick={() => void save()}>Save & connect</Button></div>
  </div>
}
const addMcp = (initial?: { name: string; config: McpServerConfig }) => dialogs.custom<boolean>({ title: initial ? `Edit ${initial.name}` : 'Add an MCP server', render: close => <McpForm close={close} initial={initial} /> })

// ───────────── installed ─────────────
function Installed() {
  const [list, setList] = useState<ExtensionInfo[]>([])
  const [bundled, setBundled] = useState<BundledExtension[]>([])
  const [registry, setRegistry] = useState<RegistryEntry[] | null | 'error'>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => { void api.extensions.list().then(setList); void api.extensions.bundled().then(setBundled) }, [])
  useEffect(() => { load(); return onEvent('ext:changed', load) }, [load])
  useEffect(() => { void api.extensions.registry().then(setRegistry).catch(() => setRegistry('error')) }, [])
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => { setBusy(key); try { await fn(); toast.success(ok); load() } catch (e) { toast.error((e as Error).message.replace(/^Error invoking.*?: /, '')) } finally { setBusy(null) } }
  const fromFolder = async () => { const d = await api.fs.pickFolder('Choose an extension folder'); if (d) await run('folder', () => api.extensions.installFromFolder(d, 'global'), 'Extension installed.') }
  const fromZip = async () => { const [f] = await api.fs.pickFiles('Choose an extension .zip', [{ name: 'Extension', extensions: ['zip'] }]); if (f) await run('zip', () => api.extensions.installFromZip(f), 'Extension installed.') }
  const fromUrl = async () => { const u = await dialogs.prompt({ title: 'Install from URL', message: 'A link to an extension .zip file.', placeholder: 'https://…/extension.zip', confirmLabel: 'Install' }); if (u) await run('url', () => api.extensions.installFromUrl(u.trim()), 'Extension installed.') }
  const scaffold = async () => { const n = await dialogs.prompt({ title: 'Create an extension', message: 'Creates a starter extension with an example tool and command that you can edit.', placeholder: 'my-extension', confirmLabel: 'Create' }); if (n) await run('scaffold', async () => { const dir = await api.extensions.scaffold(n.trim(), 'global'); void api.fs.reveal(dir) }, 'Extension created.') }
  const avail = bundled.filter(b => !b.installed)
  return <div className="col" style={{ paddingBottom: 20 }}>
    <div className="ext-actions"><Button size="sm" icon={FolderOpen} onClick={() => void fromFolder()}>Folder…</Button><Button size="sm" icon={Package} onClick={() => void fromZip()}>.zip…</Button><Button size="sm" icon={Link2} onClick={() => void fromUrl()}>URL…</Button><Button size="sm" variant="soft" icon={Plus} onClick={() => void scaffold()}>New</Button></div>
    {list.length === 0 && <div className="subtle small" style={{ padding: '10px 16px' }}>No extensions installed.</div>}
    {list.map(e => <div key={e.id} className="ext-card" onClick={() => useEditor.getState().openPage('extension', { id: e.id }, e.manifest.name)}>
      <span className="ext-ic"><Puzzle size={16} /></span>
      <div className="ext-main"><div className="row gap6"><b className="truncate">{e.manifest.name}</b><span className="subtle tiny">v{e.manifest.version}</span>{e.scope === 'bundled' && <Badge>built-in</Badge>}{e.error && <Badge kind="danger">error</Badge>}</div>
        <div className="ext-desc">{e.error ?? e.manifest.description}</div>
        <div className="row gap4" style={{ marginTop: 4, flexWrap: 'wrap' }}>{e.tools.length > 0 && <Badge>{e.tools.length} tool{e.tools.length > 1 ? 's' : ''}</Badge>}{e.commands.length > 0 && <Badge>{e.commands.length} command{e.commands.length > 1 ? 's' : ''}</Badge>}{e.themes.length > 0 && <Badge>{e.themes.length} theme{e.themes.length > 1 ? 's' : ''}</Badge>}</div></div>
      <span onClick={ev => ev.stopPropagation()}><Switch on={e.enabled} onChange={v => void run(e.id, () => api.extensions.setEnabled(e.id, v), v ? 'Enabled.' : 'Disabled.')} label={`Enable ${e.manifest.name}`} /></span>
    </div>)}
    {avail.length > 0 && <Collapsible title="Included with the app" count={avail.length} storageKey="ext-bundled">{avail.map(b => <div key={b.id} className="ext-card plain"><span className="ext-ic"><Boxes size={16} /></span><div className="ext-main"><b>{b.name}</b><div className="ext-desc">{b.description}</div></div><Button size="sm" variant="secondary" icon={Download} disabled={busy === b.id} onClick={() => void run(b.id, () => api.extensions.installBundled(b.id), `${b.name} installed.`)}>Install</Button></div>)}</Collapsible>}
    <Collapsible title="Registry" storageKey="ext-registry" defaultOpen={false}>
      {registry === null && <div className="center" style={{ padding: 16 }}><Spinner /></div>}
      {registry === 'error' && <div className="subtle small" style={{ padding: '6px 16px 10px' }}>The registry isn’t reachable (you may be offline, or no registry address is set in Settings).</div>}
      {Array.isArray(registry) && registry.length === 0 && <div className="subtle small" style={{ padding: '6px 16px 10px' }}>No extensions listed.</div>}
      {Array.isArray(registry) && registry.map(r => <div key={r.id} className="ext-card plain"><span className="ext-ic"><Globe size={16} /></span><div className="ext-main"><div className="row gap6"><b>{r.name}</b><span className="subtle tiny">v{r.version}</span></div><div className="ext-desc">{r.description}</div></div><Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void run(r.id, () => api.extensions.installFromUrl(r.downloadUrl), `${r.name} installed.`)}>Install</Button></div>)}
    </Collapsible>
    <div style={{ padding: '10px 16px' }}><Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void run('reload', () => api.extensions.reload(), 'Reloaded.')}>Reload extensions</Button></div>
  </div>
}

// ───────────── MCP ─────────────
function Mcp() {
  const [list, setList] = useState<McpServerState[]>([])
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => void api.mcp.list().then(setList), [])
  useEffect(() => { load(); void api.mcp.catalog().then(setCatalog).catch(() => undefined); const a = onEvent('mcp:changed', setList); return () => a() }, [load])
  const dot = (s: McpServerState['status']) => (s === 'connected' ? 'ok' : s === 'connecting' ? 'run' : s === 'error' ? 'err' : '')
  return <div className="col" style={{ paddingBottom: 20 }}>
    <div className="ext-actions"><Button size="sm" variant="soft" icon={Plus} onClick={async () => { if (await addMcp()) load() }}>Add server</Button><span className="subtle small grow">MCP servers give the agent extra tools — databases, browsers, GitHub, files…</span></div>
    {list.length === 0 && <div className="subtle small" style={{ padding: '4px 16px 10px' }}>No servers connected. Pick one from the list below or add your own.</div>}
    {list.map(s => <div key={s.name} className="mcp-card">
      <div className="mcp-head" onClick={() => setOpen(open === s.name ? null : s.name)}><span className={cn('status-dot', dot(s.status))} /><b className="truncate grow">{s.name}</b><span className="subtle tiny">{s.tools.length} tools</span><span onClick={e => e.stopPropagation()}><Switch on={s.config.enabled !== false} onChange={v => void api.mcp.setEnabled(s.name, v)} label={`Enable ${s.name}`} /></span></div>
      {s.error && <div className="mcp-err selectable">{s.error}</div>}
      {open === s.name && <div className="mcp-body fade-in">
        <div className="mono small subtle" style={{ wordBreak: 'break-all' }}>{s.config.url ?? [s.config.command, ...(s.config.args ?? [])].join(' ')}</div>
        {s.tools.map(t => <div key={t.fullName} className="mcp-tool" data-tip={t.description}><Wrench size={12} /><span className="mono">{t.name}</span></div>)}
        {s.logs.length > 0 && <details className="small"><summary className="subtle" style={{ cursor: 'pointer' }}>Server log</summary><pre className="t-pre selectable" style={{ maxHeight: 140 }}>{s.logs.slice(-30).join('\n')}</pre></details>}
        <div className="row gap6"><Button size="sm" icon={RefreshCw} onClick={() => void api.mcp.restart(s.name)}>Restart</Button><Button size="sm" variant="ghost" onClick={async () => { if (await addMcp({ name: s.name, config: s.config })) load() }}>Edit</Button><span className="grow" /><Button size="sm" variant="ghost" icon={Trash2} onClick={async () => { if (await dialogs.confirm({ title: `Remove ${s.name}?`, confirmLabel: 'Remove', danger: true })) { await api.mcp.remove(s.name); load() } }}>Remove</Button></div></div>}
    </div>)}
    <Collapsible title="Popular servers" count={catalog.length} storageKey="mcp-catalog">{catalog.filter(c => !list.some(s => s.name === c.id)).map(c => <div key={c.id} className="ext-card plain"><span className="ext-ic"><Server size={16} /></span><div className="ext-main"><b>{c.name}</b><div className="ext-desc">{c.description}</div>{c.needs && <div className="subtle tiny" style={{ marginTop: 2 }}>Needs: {c.needs}</div>}</div><Button size="sm" variant="secondary" onClick={async () => { if (await addMcp({ name: c.id, config: c.config })) load() }}>Add</Button></div>)}</Collapsible>
  </div>
}

// ───────────── tools ─────────────
function Tools() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [custom, setCustom] = useState<{ name: string; description: string; source: string; error?: string }[]>([])
  useEffect(() => { void api.tools.list().then(setTools); void api.extensions.customTools().then(setCustom).catch(() => undefined) }, [])
  const groups: { title: string; src: ToolInfo['source'] }[] = [{ title: 'Built-in', src: 'builtin' }, { title: 'MCP servers', src: 'mcp' }, { title: 'Extensions', src: 'plugin' }, { title: 'Custom tools', src: 'custom' }]
  return <div className="col" style={{ paddingBottom: 20 }}>
    {groups.map(g => { const list = tools.filter(t => t.source === g.src); return list.length > 0 && <Collapsible key={g.src} title={g.title} count={list.length} storageKey={'tools-' + g.src} defaultOpen={g.src === 'builtin'}>{list.map(t => <div key={t.name} className="tool-row" data-tip={t.description}><span className="mono tr-name">{t.name}</span><Badge>{t.category}</Badge></div>)}</Collapsible> })}
    {custom.filter(c => c.error).map(c => <div key={c.name} className="mcp-err selectable" style={{ margin: '6px 12px' }}><b>{c.name}</b>: {c.error}</div>)}
    <div className="subtle small" style={{ padding: '12px 16px', lineHeight: 1.5 }}>Every tool is covered by your permission rules (Settings → Permissions). Hover a tool for its description.</div>
  </div>
}

// ───────────── skills & commands ─────────────
function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [cmds, setCmds] = useState<CommandInfo[]>([])
  const root = useWorkspace(s => s.root)
  const load = useCallback(() => { void api.skills.list().then(setSkills); void api.commands.list().then(c => { setCmds(c); window.dispatchEvent(new Event('tgg:commands-changed')) }) }, [])
  useEffect(() => { load(); return onEvent('ext:changed', load) }, [load])
  const newSkill = async () => {
    const name = await dialogs.prompt({ title: 'New skill', message: 'Skills are reusable instructions the agent loads when a task matches.', placeholder: 'release-notes', validate: v => (/^[a-z0-9-]+$/.test(v.trim()) ? null : 'Lowercase letters, numbers and dashes only') }); if (!name) return
    const description = await dialogs.prompt({ title: 'When should the agent use it?', placeholder: 'Use when writing release notes from git history' }); if (!description) return
    const path = await api.skills.create(name.trim(), description.trim(), `# ${name.trim()}\n\nDescribe the steps the agent should follow.\n`, root ? 'project' : 'global'); load(); void useEditor.getState().openFile(path, { pin: true })
  }
  const newCmd = async () => {
    const name = await dialogs.prompt({ title: 'New slash command', message: 'Type /name in the chat to run it. Use $ARGUMENTS where the text you type after the command goes.', placeholder: 'changelog', validate: v => (/^[a-z0-9-]+$/.test(v.trim()) ? null : 'Lowercase letters, numbers and dashes only') }); if (!name) return
    const template = await dialogs.prompt({ title: 'What should it ask the agent?', placeholder: 'Write a changelog entry for $ARGUMENTS based on recent commits' }); if (!template) return
    await api.commands.save(name.trim(), template.trim().slice(0, 80), template.trim(), root ? 'project' : 'global'); load(); toast.success(`/${name.trim()} created.`)
  }
  return <div className="col" style={{ paddingBottom: 20 }}>
    <Collapsible title="Skills" count={skills.length} storageKey="skills" actions={<IconButton icon={Plus} size="sm" tip="New skill" onClick={() => void newSkill()} />}>
      {skills.length === 0 && <div className="subtle small" style={{ padding: '4px 18px 8px' }}>No skills yet. Add a SKILL.md folder under .tgg/skills or create one here.</div>}
      {skills.map(s => <div key={s.name} className="tool-row" onClick={() => void useEditor.getState().openFile(s.path, { pin: true })} style={{ cursor: 'pointer' }} data-tip={s.description}><Sparkles size={13} className="accent-ic" /><span className="grow truncate">{s.name}</span><Badge>{s.source}</Badge></div>)}
    </Collapsible>
    <Collapsible title="Slash commands" count={cmds.length} storageKey="cmds" actions={<IconButton icon={Plus} size="sm" tip="New command" onClick={() => void newCmd()} />}>
      {cmds.map(c => <div key={c.name} className="tool-row" data-tip={c.description}><Slash size={13} className="subtle" /><span className="mono">{c.name}</span><span className="subtle small truncate grow">{c.description}</span><Badge>{c.source}</Badge></div>)}
    </Collapsible>
    <div className="subtle small" style={{ padding: '10px 16px', lineHeight: 1.5 }}><Terminal size={12} style={{ display: 'inline', marginRight: 4 }} />Run a command by typing <b>/</b> in the message box.</div>
  </div>
}

export function ExtensionsView() {
  const [tab, setTab] = useState<Tab>('installed')
  return <>
    <div className="sb-head"><h2>Extensions</h2></div>
    <div className="sb-pad" style={{ paddingTop: 0 }}><Segmented<Tab> value={tab} options={[{ value: 'installed', label: 'Installed' }, { value: 'mcp', label: 'MCP' }, { value: 'tools', label: 'Tools' }, { value: 'skills', label: 'Skills' }]} onChange={setTab} /></div>
    <div className="sb-body">{tab === 'installed' ? <Installed /> : tab === 'mcp' ? <Mcp /> : tab === 'tools' ? <Tools /> : <Skills />}</div>
  </>
}

void Zap; void EmptyState
