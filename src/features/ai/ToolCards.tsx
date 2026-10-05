import { memo, useMemo, useState, type ReactNode } from 'react'
import { structuredPatch } from 'diff'
import {
  Bot, Brain, Check, CheckCircle2, ChevronRight, Circle, CircleDot, FilePen, FilePlus2, FileSearch, FileText, FolderTree, Globe, ImageIcon, ListChecks, MessageCircleQuestion,
  Puzzle, Search, SquareTerminal, Wrench, X, XCircle, Sparkles, GitBranch, Code2, Database, type LucideIcon
} from 'lucide-react'
import type { Todo, ToolPart } from '@shared/ai'
import { cn, formatDuration, relativeTo, basename } from '../../lib/util'
import { Spinner } from '../../components/ui'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'
import { useAi } from '../../stores/ai'
import { GithubIcon } from '../../components/brand'

// ───────────── diff ─────────────
export function DiffLines({ before, after, context = 2, maxLines = 60 }: { before: string; after: string; context?: number; maxLines?: number }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => {
    const p = structuredPatch('a', 'b', before, after, '', '', { context })
    const out: { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; a?: number; b?: number }[] = []
    for (const h of p.hunks) {
      out.push({ kind: 'hunk', text: `@@ −${h.oldStart},${h.oldLines}  +${h.newStart},${h.newLines} @@` })
      let a = h.oldStart, b = h.newStart
      for (const l of h.lines) {
        const c = l[0], t = l.slice(1)
        if (c === '+') out.push({ kind: 'add', text: t, b: b++ })
        else if (c === '-') out.push({ kind: 'del', text: t, a: a++ })
        else if (c === ' ') out.push({ kind: 'ctx', text: t, a: a++, b: b++ })
      }
    }
    return out
  }, [before, after, context])
  const shown = all ? lines : lines.slice(0, maxLines)
  if (!lines.length) return <div className="subtle small" style={{ padding: '6px 10px' }}>No textual changes.</div>
  return (
    <div className="difflines selectable">
      {shown.map((l, i) => l.kind === 'hunk'
        ? <div key={i} className="dl hunk">{l.text}</div>
        : <div key={i} className={cn('dl', l.kind)}><span className="dl-no">{l.kind === 'add' ? '' : l.a}</span><span className="dl-no">{l.kind === 'del' ? '' : l.b}</span><span className="dl-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span><span className="dl-text">{l.text || ' '}</span></div>)}
      {lines.length > maxLines && !all && <button className="dl more" onClick={() => setAll(true)}>Show {lines.length - maxLines} more lines</button>}
    </div>
  )
}

// ───────────── helpers ─────────────
const ICONS: Record<string, LucideIcon> = {
  read: FileText, list: FolderTree, glob: FileSearch, grep: Search, edit: FilePen, write: FilePlus2, apply_patch: FilePen, shell: SquareTerminal, shell_output: SquareTerminal, shell_kill: SquareTerminal,
  webfetch: Globe, websearch: Globe, lsp: Code2, todowrite: ListChecks, todoread: ListChecks, skill: Sparkles, subagent: Bot, question: MessageCircleQuestion, memory: Brain, generate_image: ImageIcon, github: GithubIcon, git: GitBranch
}
export const toolIcon = (name: string): LucideIcon => ICONS[name] ?? (name.startsWith('mcp__') ? Database : name.startsWith('plugin__') ? Puzzle : Wrench)

function inputOf(p: ToolPart): Record<string, unknown> { return p.input && typeof p.input === 'object' ? p.input as Record<string, unknown> : {} }
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function fallbackTitle(p: ToolPart, root: string | null): string {
  const i = inputOf(p)
  const rel = (v: unknown) => (typeof v === 'string' ? relativeTo(root, v) : '')
  switch (p.name) {
    case 'read': return `Read ${rel(i.path ?? i.file_path)}`
    case 'list': return `List ${rel(i.path) || '.'}`
    case 'glob': return `Find files ${str(i.pattern)}`
    case 'grep': return `Search “${str(i.pattern)}”`
    case 'edit': return `Edit ${rel(i.path ?? i.file_path)}`
    case 'write': return `Write ${rel(i.path ?? i.file_path)}`
    case 'apply_patch': return 'Apply patch'
    case 'shell': return str(i.description) || str(i.command).split('\n')[0]
    case 'webfetch': return `Fetch ${str(i.url)}`
    case 'websearch': return `Search the web “${str(i.query)}”`
    case 'subagent': return str(i.description) || `Ask ${str(i.agent)}`
    case 'todowrite': return 'Update to-do list'
    case 'skill': return `Load skill ${str(i.name)}`
    case 'question': return 'Ask a question'
    default: return p.name.replace(/^mcp__/, '').replace(/__/g, ' › ').replace(/_/g, ' ')
  }
}

function openFileRef(path: string | undefined) { if (path) void useEditor.getState().openFile(path, { pin: true }) }

function StateIcon({ s }: { s: ToolPart['state'] }) {
  if (s === 'running' || s === 'pending') return <Spinner size={13} />
  if (s === 'completed') return <Check size={13} strokeWidth={2.6} className="ok" />
  if (s === 'denied') return <XCircle size={13} className="warn" />
  return <X size={13} strokeWidth={2.6} className="err" />
}

// ───────────── the card ─────────────
function ToolCardImpl({ part, sessionId, depth = 0 }: { part: ToolPart; sessionId: string; depth?: number }) {
  const root = useWorkspace(s => s.root)
  const isEdit = part.name === 'edit' || part.name === 'write' || part.name === 'apply_patch'
  const isShell = part.name === 'shell'
  const [open, setOpen] = useState<boolean | null>(null)
  const autoOpen = (isEdit && part.state === 'completed') || (isShell && (part.state === 'running' || part.state === 'error')) || (part.name === 'subagent' && part.state === 'running')
  const expanded = open ?? autoOpen
  const Icon = toolIcon(part.name)
  const title = part.title && part.state !== 'pending' ? part.title : fallbackTitle(part, root)
  const diffs = part.meta?.diff ?? []
  const dur = part.endedAt && part.startedAt ? part.endedAt - part.startedAt : null
  const added = diffs.reduce((n, d) => n + d.added, 0), removed = diffs.reduce((n, d) => n + d.removed, 0)
  const hasBody = !!(part.output || diffs.length || part.name === 'todowrite' || part.name === 'subagent' || Object.keys(inputOf(part)).length)
  return (
    <div className={cn('tool', part.state, depth > 0 && 'nested')}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} disabled={!hasBody}>
        <ChevronRight size={13} className={cn('t-chev', expanded && 'open')} style={{ opacity: hasBody ? 1 : 0 }} />
        <span className="t-icon"><Icon size={14} strokeWidth={1.8} /></span>
        <span className="t-title truncate">{title}</span>
        {isEdit && diffs.length > 0 && <span className="t-diffstat"><span className="ok">+{added}</span> <span className="err">−{removed}</span></span>}
        {part.meta?.exitCode !== undefined && part.meta.exitCode !== null && part.meta.exitCode !== 0 && <span className="badge danger">exit {part.meta.exitCode}</span>}
        {dur !== null && dur > 1500 && <span className="t-dur">{formatDuration(dur)}</span>}
        <span className="t-state"><StateIcon s={part.state} /></span>
      </button>
      {expanded && hasBody && <div className="tool-body fade-in"><ToolBody part={part} sessionId={sessionId} depth={depth} /></div>}
    </div>
  )
}
export const ToolCard = memo(ToolCardImpl)

function Output({ text, max = 4000 }: { text: string; max?: number }) {
  const [all, setAll] = useState(false)
  const t = all || text.length <= max ? text : text.slice(0, max)
  return <><pre className="t-pre selectable">{t}</pre>{text.length > max && !all && <button className="link-btn small" style={{ padding: '2px 10px 6px' }} onClick={() => setAll(true)}>Show all ({Math.round(text.length / 1000)}k chars)</button>}</>
}

function ToolBody({ part, sessionId, depth }: { part: ToolPart; sessionId: string; depth: number }) {
  const i = inputOf(part)
  const root = useWorkspace(s => s.root)
  const diffs = part.meta?.diff ?? []
  if (diffs.length) {
    return <>{diffs.map(d => {
      const abs = root ? root.replace(/[\\/]$/, '') + '/' + d.path : d.path
      return <div key={d.path} className="diff-card">
        <div className="diff-file"><button className="link-file" onClick={() => openFileRef(part.meta?.path && diffs.length === 1 ? String(part.meta.path) : abs)}>{d.path}</button><span className="grow" /><span className="ok small">+{d.added}</span><span className="err small">−{d.removed}</span>
          <button className="link-btn small" onClick={() => useEditor.getState().openDiff({ mode: 'agent', path: abs, original: d.before, modified: d.after, originalLabel: 'Before', modifiedLabel: 'After', readOnly: true, sessionId })}>Open diff</button></div>
        <DiffLines before={d.before} after={d.after} />
      </div>
    })}{part.state === 'error' && part.output && <Output text={part.output} />}</>
  }
  switch (part.name) {
    case 'shell': {
      const out = part.output ?? ''
      return <div className="t-term selectable"><div className="t-cmd"><span className="prompt">$</span> {str(i.command)}</div>{out && <Output text={out} />}{part.state === 'running' && !out && <div className="t-cmd subtle">running…</div>}</div>
    }
    case 'todowrite': {
      const todos = (Array.isArray(i.todos) ? i.todos : []) as Todo[]
      return <TodoList todos={todos} />
    }
    case 'subagent': return <SubagentBody part={part} depth={depth} />
    case 'question': return part.output ? <Output text={part.output} /> : null
    case 'read': case 'list': case 'glob': case 'grep': case 'websearch': case 'webfetch': case 'lsp': case 'skill':
      return <>{part.output ? <Output text={part.output} max={2400} /> : <div className="subtle small" style={{ padding: 8 }}>No output.</div>}</>
    default: {
      const inputText = Object.keys(i).length ? JSON.stringify(part.input, null, 2) : ''
      return <>{inputText && <><div className="t-label">Input</div><pre className="t-pre selectable">{inputText}</pre></>}{part.output && <><div className="t-label">Result</div><Output text={part.output} /></>}</>
    }
  }
}

export function TodoList({ todos, compact }: { todos: Todo[]; compact?: boolean }) {
  return <div className={cn('todos', compact && 'compact')}>{todos.map(t => <div key={t.id} className={cn('todo', t.status)}>
    <span className="todo-ic">{t.status === 'completed' ? <CheckCircle2 size={14} /> : t.status === 'in_progress' ? <CircleDot size={14} /> : <Circle size={14} />}</span>
    <span className="todo-text">{t.content}</span>
  </div>)}</div>
}

function SubagentBody({ part, depth }: { part: ToolPart; depth: number }) {
  const childId = part.meta?.childSessionId
  const child = useAi(s => (childId ? s.data[childId] : undefined))
  const i = inputOf(part)
  const steps = child?.messages.flatMap(m => m.parts.filter((p): p is ToolPart => p.type === 'tool')) ?? []
  const lastText = child ? [...child.messages].reverse().find(m => m.role === 'assistant')?.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n') : ''
  return <div className="sub-body">
    <div className="sub-prompt selectable"><span className="t-label" style={{ padding: 0 }}>{str(i.agent) || 'agent'}</span> {str(i.prompt).slice(0, 400)}</div>
    {steps.length > 0 && <div className="sub-steps">{steps.slice(-12).map(s => <ToolCard key={s.id} part={s} sessionId={child!.id} depth={depth + 1} />)}</div>}
    {part.state === 'completed' && (lastText || part.output) && <div className="sub-result selectable">{(lastText || part.output || '').slice(0, 1200)}</div>}
  </div>
}

// ───────────── grouping of consecutive tool calls ─────────────
export function ToolGroupSummary({ parts }: { parts: ToolPart[] }): ReactNode {
  const counts: Record<string, number> = {}
  for (const p of parts) counts[p.name] = (counts[p.name] ?? 0) + 1
  const label = (n: string, c: number) => ({ read: `read ${c} file${c > 1 ? 's' : ''}`, grep: `${c} search${c > 1 ? 'es' : ''}`, glob: `${c} file search${c > 1 ? 'es' : ''}`, list: `listed ${c} folder${c > 1 ? 's' : ''}`, edit: `${c} edit${c > 1 ? 's' : ''}`, write: `wrote ${c} file${c > 1 ? 's' : ''}`, shell: `ran ${c} command${c > 1 ? 's' : ''}` } as Record<string, string>)[n] ?? `${n.replace(/^mcp__/, '')} ×${c}`
  return Object.entries(counts).map(([n, c]) => label(n, c)).join(', ')
}

void basename
