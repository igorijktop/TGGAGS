import { useEffect, useState, type ReactNode } from 'react'
import { Code2, Folder, Info, Keyboard, Languages, Layers, Lock, Palette, Plus, Settings2, ShieldCheck, Sparkles, SquareTerminal, Trash2, Webhook, Cpu, ExternalLink } from 'lucide-react'
import type { HookConfig, HookEvent, LspServerConfig, Settings } from '@shared/settings'
import type { MemoryState } from '@shared/ai'
import type { AppInfo } from '@shared/api'
import { api } from '../../lib/api'
import { allThemes } from '../../lib/theme'
import { cn, uid } from '../../lib/util'
import { Button, IconButton, Segmented, Switch } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { useAi } from '../../stores/ai'
import { useEditor } from '../../stores/editor'
import { dialogs, toast } from '../../stores/ui'
import { Logo } from '../../components/brand'
import { ModelPicker, EFFORTS, MODES } from '../ai/Selectors'
import { ThemeCard } from '../home/Onboarding'
import { Group, NumberField, Row, Section, SelectField, Slider, TextArea, TextField, ToggleRow } from './rows'
import { PermissionsSection } from './PermissionsSection'
import { KeybindingsSection } from './KeybindingsSection'

type Id = 'general' | 'appearance' | 'editor' | 'terminal' | 'ai' | 'permissions' | 'context' | 'hooks' | 'languages' | 'keyboard' | 'privacy' | 'about'
const NAV: { id: Id; label: string; icon: typeof Palette }[] = [
  { id: 'general', label: 'General', icon: Settings2 }, { id: 'appearance', label: 'Appearance', icon: Palette }, { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal }, { id: 'ai', label: 'AI & agents', icon: Sparkles }, { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'context', label: 'Context & memory', icon: Layers }, { id: 'hooks', label: 'Hooks', icon: Webhook }, { id: 'languages', label: 'Language servers', icon: Languages },
  { id: 'keyboard', label: 'Keyboard shortcuts', icon: Keyboard }, { id: 'privacy', label: 'Data & privacy', icon: Lock }, { id: 'about', label: 'About', icon: Info }
]

/** Typed accessor for a settings section with a patch helper. */
function useSec<K extends keyof Settings>(k: K): [Settings[K], (p: Partial<Settings[K]>) => void] {
  const v = useSettings(s => s.settings[k])
  const update = useSettings(s => s.update)
  return [v, p => void update({ [k]: p } as never)]
}

// ───────────── sections ─────────────
function General() {
  const [ai, setAi] = useSec('ai')
  const [web, setWeb] = useSec('web')
  const [git, setGit] = useSec('git')
  const [gh, setGh] = useSec('github')
  const [ui, setUi] = useSec('ui')
  return <Section title="General" description="How the app behaves day to day.">
    <Group title="Language">
      <Row title="Agent reply language" description="Leave empty to answer in the language you write in."><TextField width={200} value={ai.responseLanguage} placeholder="e.g. Русский, Español" onChange={v => setAi({ responseLanguage: v })} /></Row>
    </Group>
    <Group title="Web access for the agent">
      <Row title="Search engine" description="Used by the web search tool. DuckDuckGo needs no key."><SelectField value={web.searchProvider} options={[{ value: 'duckduckgo', label: 'DuckDuckGo' }, { value: 'searxng', label: 'SearXNG (self-hosted)' }, { value: 'brave', label: 'Brave Search' }, { value: 'tavily', label: 'Tavily' }]} onChange={v => setWeb({ searchProvider: v })} /></Row>
      {web.searchProvider === 'searxng' && <Row title="SearXNG address"><TextField value={web.searxngUrl} placeholder="http://localhost:8080" onChange={v => setWeb({ searxngUrl: v })} /></Row>}
      <Row title="Largest page to read" description="Longer web pages are cut after this many characters."><NumberField value={web.maxFetchChars} min={5000} max={400000} step={5000} onChange={v => setWeb({ maxFetchChars: v })} /></Row>
    </Group>
    <Group title="Git & GitHub">
      <ToggleRow title="Fetch automatically" description="Check the remote for new commits every few minutes." value={git.autoFetch} onChange={v => setGit({ autoFetch: v })} />
      <ToggleRow title="Confirm before syncing" description="Ask before pulling and pushing with the Sync button." value={git.confirmSync} onChange={v => setGit({ confirmSync: v })} />
      <ToggleRow title="GitHub integration" description="Pull requests, issues and the GitHub tool for the agent (needs a token in the GitHub panel)." value={gh.enabled} onChange={v => setGh({ enabled: v })} />
    </Group>
    <Group title="Welcome">
      <Row title="Setup guide" description="Show the first-run welcome again."><Button size="sm" onClick={() => setUi({ onboarded: false })}>Show again</Button></Row>
    </Group>
  </Section>
}

function Appearance() {
  const [a, setA] = useSec('appearance')
  const themes = allThemes()
  return <Section title="Appearance" description="Make it comfortable for long sessions.">
    <Group title="Theme">
      <div className="set-row stack"><div className="theme-grid six">{themes.map(t => <ThemeCard key={t.id} id={t.id} name={t.name} kind={t.kind === 'dark' ? 'Dark' : 'Light'} ui={t.ui} on={a.theme === t.id} onPick={() => setA({ theme: t.id })} />)}</div></div>
    </Group>
    <Group title="Interface">
      <Row title="Chat font" description="Reading font for the conversation with the agent."><Segmented value={a.chatFont} options={[{ value: 'serif', label: 'Serif' }, { value: 'sans', label: 'Sans' }, { value: 'mono', label: 'Mono' }]} onChange={v => setA({ chatFont: v })} /></Row>
      <Row title="Interface size" description="Scales the whole window."><Slider value={a.uiScale} min={0.8} max={1.4} step={0.05} format={v => `${Math.round(v * 100)}%`} onChange={v => setA({ uiScale: v })} /></Row>
      <ToggleRow title="Labels under activity icons" description="Show a name below each icon in the left bar." value={a.activityBarLabels} onChange={v => setA({ activityBarLabels: v })} />
      <ToggleRow title="Compact layout" description="Tighter spacing and a narrower activity bar." value={a.compact} onChange={v => setA({ compact: v })} />
      <Row title="Animations" description="Reduce motion if animations bother you."><Segmented value={a.motion} options={[{ value: 'system', label: 'Follow system' }, { value: 'reduced', label: 'Reduced' }]} onChange={v => setA({ motion: v })} /></Row>
    </Group>
  </Section>
}

function Editor() {
  const [e, setE] = useSec('editor')
  return <Section title="Editor" description="Fonts, indentation and editing behaviour.">
    <Group title="Text">
      <Row title="Font family"><TextField width={300} mono value={e.fontFamily} onChange={v => setE({ fontFamily: v })} /></Row>
      <Row title="Font size"><NumberField value={e.fontSize} min={8} max={32} step={0.5} suffix="px" onChange={v => setE({ fontSize: v })} /></Row>
      <Row title="Line height"><NumberField value={e.lineHeight} min={1} max={3} step={0.05} onChange={v => setE({ lineHeight: v })} /></Row>
      <ToggleRow title="Font ligatures" description="Join characters like => and !== in fonts that support it." value={e.ligatures} onChange={v => setE({ ligatures: v })} />
      <Row title="Word wrap"><SelectField value={e.wordWrap} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'bounded', label: 'At 80 columns' }]} onChange={v => setE({ wordWrap: v })} /></Row>
    </Group>
    <Group title="Indentation">
      <Row title="Tab size"><NumberField value={e.tabSize} min={1} max={8} onChange={v => setE({ tabSize: v })} /></Row>
      <ToggleRow title="Insert spaces" description="Press Tab to insert spaces instead of a tab character." value={e.insertSpaces} onChange={v => setE({ insertSpaces: v })} />
    </Group>
    <Group title="Display">
      <ToggleRow title="Minimap" value={e.minimap} onChange={v => setE({ minimap: v })} />
      <ToggleRow title="Breadcrumbs" value={e.breadcrumbs} onChange={v => setE({ breadcrumbs: v })} />
      <ToggleRow title="Sticky scroll" description="Keep the current function/class header visible while scrolling." value={e.stickyScroll} onChange={v => setE({ stickyScroll: v })} />
      <ToggleRow title="Code folding" value={e.folding} onChange={v => setE({ folding: v })} />
      <ToggleRow title="Colourful bracket pairs" value={e.bracketPairColorization} onChange={v => setE({ bracketPairColorization: v })} />
      <ToggleRow title="Smooth scrolling" value={e.smoothScrolling} onChange={v => setE({ smoothScrolling: v })} />
      <Row title="Line numbers"><SelectField value={e.lineNumbers} options={[{ value: 'on', label: 'On' }, { value: 'relative', label: 'Relative' }, { value: 'off', label: 'Off' }]} onChange={v => setE({ lineNumbers: v })} /></Row>
      <Row title="Show whitespace"><SelectField value={e.renderWhitespace} options={[{ value: 'none', label: 'Never' }, { value: 'selection', label: 'In selection' }, { value: 'boundary', label: 'At boundaries' }, { value: 'all', label: 'Always' }]} onChange={v => setE({ renderWhitespace: v })} /></Row>
      <Row title="Cursor style"><SelectField value={e.cursorStyle} options={[{ value: 'line', label: 'Line' }, { value: 'block', label: 'Block' }, { value: 'underline', label: 'Underline' }]} onChange={v => setE({ cursorStyle: v })} /></Row>
      <Row title="Cursor blinking"><SelectField value={e.cursorBlinking} options={[{ value: 'smooth', label: 'Smooth' }, { value: 'blink', label: 'Blink' }, { value: 'phase', label: 'Phase' }, { value: 'expand', label: 'Expand' }, { value: 'solid', label: 'Solid' }]} onChange={v => setE({ cursorBlinking: v })} /></Row>
    </Group>
    <Group title="Saving">
      <Row title="Auto save"><SelectField value={e.autoSave} options={[{ value: 'afterDelay', label: 'After a short delay' }, { value: 'onFocusChange', label: 'When focus leaves' }, { value: 'off', label: 'Never' }]} onChange={v => setE({ autoSave: v })} /></Row>
      {e.autoSave === 'afterDelay' && <Row title="Delay"><NumberField value={e.autoSaveDelay} min={300} max={10000} step={100} suffix="ms" onChange={v => setE({ autoSaveDelay: v })} /></Row>}
      <ToggleRow title="Format on save" description="Runs the formatter for the file type (Prettier for web languages)." value={e.formatOnSave} onChange={v => setE({ formatOnSave: v })} />
    </Group>
  </Section>
}

function Terminal() {
  const [t, setT] = useSec('terminal')
  return <Section title="Terminal" description="The integrated terminal.">
    <Group>
      <Row title="Shell program" description="Leave empty to use your system default (PowerShell on Windows, your login shell elsewhere)."><TextField width={260} mono value={t.shell} placeholder="auto" onChange={v => setT({ shell: v })} /></Row>
      <Row title="Font size"><NumberField value={t.fontSize} min={8} max={28} suffix="px" onChange={v => setT({ fontSize: v })} /></Row>
      <Row title="Cursor"><SelectField value={t.cursorStyle} options={[{ value: 'bar', label: 'Bar' }, { value: 'block', label: 'Block' }, { value: 'underline', label: 'Underline' }]} onChange={v => setT({ cursorStyle: v })} /></Row>
      <Row title="Scrollback lines"><NumberField value={t.scrollback} min={500} max={100000} step={500} onChange={v => setT({ scrollback: v })} /></Row>
      <ToggleRow title="Copy on select" value={t.copyOnSelect} onChange={v => setT({ copyOnSelect: v })} />
    </Group>
  </Section>
}

function AiSettings() {
  const [ai, setAi] = useSec('ai')
  const agents = useAi(s => s.agents)
  return <Section title="AI & agents" description="Defaults for new chats. You can still change them per chat from the message box.">
    <Group title="Defaults">
      <Row title="Model"><ModelPicker value={ai.defaultModel} onChange={m => setAi({ defaultModel: m })} placement="bottom-end" /></Row>
      <Row title="Agent" description="Build can edit and run things. Plan only reads and proposes."><SelectField value={ai.defaultAgent} options={agents.filter(a => a.mode !== 'subagent' && !a.hidden).map(a => ({ value: a.id, label: a.name }))} onChange={v => setAi({ defaultAgent: v })} /></Row>
      <Row title="Permissions"><SelectField width={220} value={ai.permissionMode} options={MODES.map(m => ({ value: m.id, label: m.title }))} onChange={v => setAi({ permissionMode: v })} /></Row>
      <Row title="Reasoning effort" description="How long the model thinks before answering. Higher is slower and costs more."><SelectField value={ai.reasoning} options={EFFORTS.map(e => ({ value: e.id, label: e.label }))} onChange={v => setAi({ reasoning: v })} /></Row>
      <ToggleRow title="Show reasoning" description="Display the model’s thinking in the chat when available." value={ai.showReasoning} onChange={v => setAi({ showReasoning: v })} />
    </Group>
    <Group title="Limits & reliability">
      <Row title="Maximum steps per request" description="Stops runaway loops. Each tool call is one step."><NumberField value={ai.maxSteps} min={5} max={400} onChange={v => setAi({ maxSteps: v })} /></Row>
      <Row title="Request timeout"><NumberField value={ai.requestTimeoutSec} min={20} max={900} suffix="sec" onChange={v => setAi({ requestTimeoutSec: v })} /></Row>
      <Row title="Retries on errors" description="Rate limits and network hiccups are retried with a delay."><NumberField value={ai.maxRetries} min={0} max={8} onChange={v => setAi({ maxRetries: v })} /></Row>
    </Group>
    <Group title="Long conversations">
      <ToggleRow title="Compact automatically" description="Summarise older messages when the context window fills up." value={ai.autoCompact} onChange={v => setAi({ autoCompact: v })} />
      {ai.autoCompact && <Row title="Compact at"><Slider value={ai.compactThreshold} min={0.5} max={0.95} step={0.05} format={v => `${Math.round(v * 100)}%`} onChange={v => setAi({ compactThreshold: v })} /></Row>}
      <ToggleRow title="Attach context automatically" description="Include the open file, selection, problems and relevant files with your message." value={ai.autoContext} onChange={v => setAi({ autoContext: v })} />
    </Group>
    <Group title="Custom instructions" hint="Added to every conversation. Project-specific rules belong in an AGENTS.md file in your project.">
      <div className="set-row stack"><TextArea rows={4} value={ai.systemPromptSuffix} placeholder="e.g. Always write TypeScript with strict types. Prefer small, focused commits." onChange={v => setAi({ systemPromptSuffix: v })} /></div>
    </Group>
    <Group><Row title="Models & providers" description="API keys, endpoints, routing and fallbacks."><Button size="sm" icon={Cpu} onClick={() => useEditor.getState().openPage('models', undefined, 'Models & providers')}>Open</Button></Row>
      <Row title="Agents" description="Built-in specialists and your own custom agents."><Button size="sm" onClick={() => useEditor.getState().openPage('agents', undefined, 'Agents')}>Open</Button></Row></Group>
  </Section>
}

function ContextSettings() {
  const [c, setC] = useSec('context')
  const [mem, setMem] = useState<MemoryState | null>(null)
  useEffect(() => { void api.memory.get().then(setMem) }, [])
  const saveMem = async (scope: 'project' | 'global', text: string) => { await api.memory.set(scope, text); setMem(await api.memory.get()); toast.success('Memory saved') }
  return <Section title="Context & memory" description="What the agent can see, and what it remembers between chats.">
    <Group title="Context">
      <ToggleRow title="Hide secrets" description="Replace API keys, tokens and passwords with a placeholder before anything is sent to a model." value={c.redactSecrets} onChange={v => setC({ redactSecrets: v })} />
      <Row title="Largest file attached whole" description="Bigger files are trimmed to this many tokens."><NumberField value={c.maxFileTokens} min={1000} max={100000} step={1000} suffix="tokens" onChange={v => setC({ maxFileTokens: v })} /></Row>
      <Row title="Largest single attachment"><NumberField value={c.maxItemTokens} min={1000} max={100000} step={1000} suffix="tokens" onChange={v => setC({ maxItemTokens: v })} /></Row>
    </Group>
    <Group title="Never include these files" hint="One glob pattern per line. Used for search, automatic context and @-mentions.">
      <div className="set-row stack"><TextArea mono rows={6} value={c.excludePatterns.join('\n')} onChange={v => setC({ excludePatterns: v.split('\n').map(x => x.trim()).filter(Boolean) })} /></div>
    </Group>
    <Group title="Memory" hint="Notes the agent can read and update. Project memory lives in your project folder; global memory applies everywhere.">
      <div className="set-row stack"><div className="set-row-title">Project memory{mem?.projectPath ? <span className="subtle small mono"> · {mem.projectPath}</span> : null}</div>
        {mem?.projectPath ? <TextArea mono rows={5} value={mem.project} placeholder="Facts about this project the agent should remember…" onChange={v => void saveMem('project', v)} /> : <div className="subtle small">Open a project to edit its memory.</div>}</div>
      <div className="set-row stack"><div className="set-row-title">Global memory</div><TextArea mono rows={5} value={mem?.global ?? ''} placeholder="Your preferences that apply to every project…" onChange={v => void saveMem('global', v)} /></div>
    </Group>
  </Section>
}

const HOOK_EVENTS: { value: HookEvent; label: string }[] = [
  { value: 'session.start', label: 'Chat starts' }, { value: 'message.before', label: 'Before a message is sent' }, { value: 'tool.before', label: 'Before a tool runs' },
  { value: 'tool.after', label: 'After a tool runs' }, { value: 'file.edited', label: 'A file is edited by the agent' }, { value: 'turn.end', label: 'The agent finishes' }, { value: 'error', label: 'An error happens' }
]
function Hooks() {
  const hooks = useSettings(s => s.settings.hooks)
  const setSection = useSettings(s => s.setSection)
  const save = (next: HookConfig[]) => void setSection('hooks', next)
  const patch = (id: string, p: Partial<HookConfig>) => save(hooks.map(h => (h.id === id ? { ...h, ...p } : h)))
  return <Section title="Hooks" description="Run your own commands when something happens — format files after edits, run tests when the agent finishes, block risky tools, or send a notification."
    actions={<Button icon={Plus} onClick={() => save([...hooks, { id: uid('hook-'), event: 'file.edited', command: '', enabled: true }])}>Add hook</Button>}>
    {hooks.length === 0 && <div className="card set-empty"><Webhook size={22} /><div><b>No hooks yet</b><p>Example: run <code>npm test</code> every time the agent finishes. Your command receives the event details (tool, file path, working folder…) as JSON on standard input, and <code>TGG_HOOK_EVENT</code> in its environment. With “Blocks the agent” on, a command that fails (non-zero exit) stops the action and its output is shown to the agent.</p></div></div>}
    {hooks.map(h => <div key={h.id} className="card hook-card">
      <div className="row gap8"><SelectField width={230} value={h.event} options={HOOK_EVENTS} onChange={v => patch(h.id, { event: v })} />
        {h.event.startsWith('tool.') && <TextField width={150} mono value={h.match ?? ''} placeholder="tool, e.g. edit|write" onChange={v => patch(h.id, { match: v.trim() || undefined })} />}
        <span className="grow" /><span className="small muted">Blocks the agent</span><Switch on={!!h.blocking} onChange={v => patch(h.id, { blocking: v })} /><span className="small muted">On</span><Switch on={h.enabled} onChange={v => patch(h.id, { enabled: v })} /><IconButton icon={Trash2} size="sm" tip="Delete hook" onClick={() => save(hooks.filter(x => x.id !== h.id))} /></div>
      <TextField width="100%" mono value={h.command} placeholder='Command to run, e.g. npm test' onChange={v => patch(h.id, { command: v })} />
    </div>)}
  </Section>
}

function LanguageServers() {
  const [l, setL] = useSec('lsp')
  const [fm, setFm] = useSec('formatters')
  const setServer = (name: string, p: Partial<LspServerConfig>) => setL({ servers: { ...l.servers, [name]: { ...l.servers[name], ...p } } })
  return <Section title="Language servers" description="Code intelligence — completions, errors, go-to-definition. TypeScript and JavaScript work out of the box; other languages need their server installed on your computer.">
    <Group>
      <ToggleRow title="Language servers" description="Turn all code intelligence on or off." value={l.enabled} onChange={v => setL({ enabled: v })} />
      <ToggleRow title="TypeScript & JavaScript" description="Built in — nothing to install." value={l.typescript} onChange={v => setL({ typescript: v })} />
    </Group>
    <Group title="Other languages" hint="Install the program, make sure it is on your PATH, and switch it on.">
      {Object.entries(l.servers).map(([name, cfg]) => <div key={name} className="set-row"><div className="set-row-main"><div className="set-row-title" style={{ textTransform: 'capitalize' }}>{name}</div><div className="set-row-desc">{cfg.languages.join(', ')}</div></div>
        <div className="set-row-ctl"><TextField width={200} mono value={[cfg.command, ...(cfg.args ?? [])].join(' ')} onChange={v => { const [command, ...args] = v.trim().split(/\s+/); setServer(name, { command, args }) }} /><Switch on={cfg.enabled} onChange={v => setServer(name, { enabled: v })} /></div></div>)}
    </Group>
    <Group title="Formatters" hint="Used by Format Document and Format on save for languages Prettier does not cover.">
      {Object.entries(fm).map(([name, cfg]) => <div key={name} className="set-row"><div className="set-row-main"><div className="set-row-title" style={{ textTransform: 'capitalize' }}>{name}</div></div>
        <div className="set-row-ctl"><TextField width={200} mono value={[cfg.command, ...(cfg.args ?? [])].join(' ')} onChange={v => { const [command, ...args] = v.trim().split(/\s+/); setFm({ [name]: { ...cfg, command, args } } as never) }} /><Switch on={cfg.enabled} onChange={v => setFm({ [name]: { ...cfg, enabled: v } } as never)} /></div></div>)}
    </Group>
  </Section>
}

function Privacy() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [secure, setSecure] = useState<boolean | null>(null)
  const ui = useSettings(s => s.settings.ui)
  useEffect(() => { void api.app.info().then(setInfo); void api.credentials.secure().then(setSecure) }, [])
  return <Section title="Data & privacy" description="Everything stays on this computer. The app only talks to the AI providers and websites you set up.">
    <Group title="Your data">
      <Row title="API keys" description={secure === null ? '' : secure ? 'Stored encrypted with your operating system’s secure storage.' : 'Secure storage is not available here, so keys are stored obfuscated in the app data folder.'}><span className={cn('badge', secure ? 'success' : 'warning')}>{secure ? 'Encrypted' : 'Obfuscated'}</span></Row>
      <Row title="App data folder" description={info?.userData ?? ''}><Button size="sm" icon={Folder} onClick={() => void api.app.openUserData()}>Open</Button></Row>
      <Row title="Logs" description="Diagnostic output for troubleshooting."><Button size="sm" icon={ExternalLink} onClick={() => void api.app.openLogs()}>Open</Button></Row>
      <Row title="Recent projects" description={`${ui.recentProjects.length} remembered`}><Button size="sm" disabled={!ui.recentProjects.length} onClick={() => void useSettings.getState().update({ ui: { recentProjects: [] } } as never)}>Clear</Button></Row>
    </Group>
    <Group title="Reset">
      <Row title="Reset all settings" description="Restores defaults. Your chats, API keys and projects are not touched."><Button size="sm" variant="danger" onClick={async () => { if (await dialogs.confirm({ title: 'Reset all settings?', message: 'Appearance, editor, AI, permission and provider settings go back to their defaults.', confirmLabel: 'Reset', danger: true })) { await api.settings.reset(); toast.success('Settings reset.'); void useSettings.getState().load() } }}>Reset</Button></Row>
    </Group>
  </Section>
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => { void api.app.info().then(setInfo) }, [])
  return <Section title="About" description="">
    <div className="card about"><Logo size={64} /><div><h3>TGGAGS</h3><div className="muted">An AI-powered code editor · version {info?.version ?? '…'}</div></div></div>
    <Group>
      <Row title="Electron">{info?.electron}</Row><Row title="Chromium">{info?.chrome}</Row><Row title="Node.js">{info?.node}</Row><Row title="Platform">{info ? `${info.platform} ${info.arch}` : ''}</Row>
    </Group>
  </Section>
}

// ───────────── page ─────────────
const BODY: Record<Id, () => ReactNode> = {
  general: General, appearance: Appearance, editor: Editor, terminal: Terminal, ai: AiSettings, permissions: () => <Section title="Permissions" description="Decide what the agent may do without asking."><PermissionsSection /></Section>,
  context: ContextSettings, hooks: Hooks, languages: LanguageServers, keyboard: () => <Section title="Keyboard shortcuts" description="Every command can have its own shortcut."><KeyboardWrap /></Section>, privacy: Privacy, about: About
}
const KeyboardWrap = () => <KeybindingsSection />

export function SettingsPage({ section }: { section?: string }) {
  const [id, setId] = useState<Id>((NAV.some(n => n.id === section) ? section : 'general') as Id)
  useEffect(() => { if (section && NAV.some(n => n.id === section)) setId(section as Id) }, [section])
  const Body = BODY[id]
  return <div className="settings">
    <nav className="set-nav" aria-label="Settings sections">
      <h1 className="serif">Settings</h1>
      {NAV.map(n => <button key={n.id} className={cn('set-nav-item', id === n.id && 'on')} onClick={() => setId(n.id)}><n.icon size={16} strokeWidth={1.8} />{n.label}</button>)}
    </nav>
    <div className="set-body"><div className="set-col" key={id}><Body /></div></div>
  </div>
}
