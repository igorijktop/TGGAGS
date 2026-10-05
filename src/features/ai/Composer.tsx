import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, AtSign, Bot, FileText, Folder, Globe, GitCompare, ImagePlus, Link2, Paperclip, Plus, Slash, Square, SquareTerminal, TextSelect, TriangleAlert, X, Clock, Terminal } from 'lucide-react'
import type { ContextItem, ImageData, Mention, SendRequest } from '@shared/ai'
import type { CommandInfo } from '@shared/ai'
import { api, bridge } from '../../lib/api'
import { basename, cn, copyText, dirname, fuzzy, relativeTo } from '../../lib/util'
import { Highlight, IconButton, MenuButton } from '../../components/ui'
import { useAi } from '../../stores/ai'
import { useWorkspace } from '../../stores/workspace'
import { useUi, toast, dialogs } from '../../stores/ui'
import { gatherEditorContext } from '../../lib/editor-context'
import { FileIcon } from '../../lib/icons'
import { AgentPicker, EffortPicker, ModePicker, ModelPicker, useChatModels } from './Selectors'
import { useDiagnostics } from '../../lib/lsp-monaco'
import { useEditor } from '../../stores/editor'

const EMPTY = { text: '', images: [] as ImageData[], mentions: [] as Mention[] }
const IMG_RE = /^image\/(png|jpe?g|gif|webp)$/

interface MenuItem { key: string; label: string; detail?: string; kind: 'file' | 'folder' | 'agent' | 'cmd'; indices: number[]; insert: string; mention?: Mention; cmd?: string; hint?: string }

const LOCAL_COMMANDS: { name: string; description: string }[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'compact', description: 'Summarise the conversation to free up context' },
  { name: 'undo', description: 'Undo the file changes of the last turn' },
  { name: 'redo', description: 'Re-apply the changes that were undone' },
  { name: 'export', description: 'Copy this chat as Markdown' }
]

function readImage(file: File): Promise<ImageData | null> {
  return new Promise(resolve => {
    if (!IMG_RE.test(file.type) || file.size > 12 * 1024 * 1024) { resolve(null); return }
    const r = new FileReader()
    r.onload = () => { const s = String(r.result); resolve({ mime: file.type, data: s.slice(s.indexOf(',') + 1), name: file.name || 'pasted-image.png' }) }
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

export interface ComposerProps { sessionId: string | null; variant?: 'panel' | 'hero'; autoFocus?: boolean; placeholder?: string; onSubmitted?(): void; /** use a separate draft (e.g. the home page) instead of the chat's own */ draftKey?: string }

export function Composer({ sessionId, variant = 'panel', autoFocus, placeholder, onSubmitted, draftKey }: ComposerProps) {
  const key = draftKey ?? sessionId ?? 'new'
  const draft = useAi(s => s.drafts[key]) ?? EMPTY
  const composer = useAi(s => s.composer)
  const running = useAi(s => (sessionId ? !!s.running[sessionId] : false))
  const queue = useAi(s => (sessionId ? s.queue[sessionId] : undefined)) ?? []
  const setDraft = useAi(s => s.setDraft)
  const setComposer = useAi(s => s.setComposer)
  const agents = useAi(s => s.agents)
  const root = useWorkspace(s => s.root)
  const models = useChatModels()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [idx, setIdx] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [files, setFiles] = useState<string[] | null>(null)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [drag, setDrag] = useState(false)
  const maxH = variant === 'hero' ? 300 : 220

  const set = useCallback((p: Partial<typeof EMPTY>) => setDraft(key, p), [key, setDraft])

  // ── focus + autosize
  useEffect(() => { if (autoFocus) taRef.current?.focus() }, [autoFocus, key])
  useEffect(() => {
    const f = () => { taRef.current?.focus() }
    window.addEventListener('tgg:focus-composer', f)
    return () => window.removeEventListener('tgg:focus-composer', f)
  }, [])
  useEffect(() => { const ta = taRef.current; if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px' }, [draft.text, maxH])
  useEffect(() => {
    const load = () => api.commands.list().then(setCommands).catch(() => undefined)
    void load()
    window.addEventListener('tgg:commands-changed', load)
    return () => window.removeEventListener('tgg:commands-changed', load)
  }, [root])

  // ── trigger detection (@ or /)
  const trigger = useMemo(() => {
    const before = draft.text.slice(0, caret)
    const at = /(^|\s)@([^\s@]*)$/.exec(before)
    if (at) return { type: '@' as const, query: at[2], start: before.length - at[2].length - 1 }
    const sl = /^\/([\w:-]*)$/.exec(before)
    if (sl && !before.includes('\n')) return { type: '/' as const, query: sl[1], start: 0 }
    return null
  }, [draft.text, caret])
  const triggerId = trigger ? `${trigger.type}${trigger.start}:${trigger.query}` : null
  useEffect(() => { setIdx(0) }, [triggerId])
  useEffect(() => { if (trigger?.type === '@' && files === null) { setFiles([]); void useWorkspace.getState().fileList().then(setFiles).catch(() => setFiles([])) } }, [trigger?.type, files])

  const items: MenuItem[] = useMemo(() => {
    if (!trigger || dismissed === triggerId) return []
    const q = trigger.query
    if (trigger.type === '/') {
      const all = [...LOCAL_COMMANDS.map(c => ({ ...c, hint: undefined as string | undefined })), ...commands.filter(c => !LOCAL_COMMANDS.some(l => l.name === c.name)).map(c => ({ name: c.name, description: c.description, hint: c.hint }))]
      return all.map(c => ({ c, m: fuzzy(q, c.name) })).filter(x => x.m).sort((a, b) => b.m!.score - a.m!.score).slice(0, 9)
        .map(({ c, m }) => ({ key: '/' + c.name, label: '/' + c.name, detail: c.description, kind: 'cmd' as const, indices: m!.indices.map(i => i + 1), insert: `/${c.name} `, cmd: c.name, hint: c.hint }))
    }
    const out: MenuItem[] = []
    for (const a of agents.filter(a => !a.hidden)) {
      const m = fuzzy(q, a.id)
      if (m) out.push({ key: 'a:' + a.id, label: a.name, detail: a.description, kind: 'agent', indices: [], insert: `@${a.id} `, mention: { kind: 'agent', value: a.id } })
    }
    const fl = files ?? []
    const scored: { path: string; folder: boolean; score: number; indices: number[] }[] = []
    if (q) {
      for (const p of fl) { const m = fuzzy(q, p); if (m) scored.push({ path: p, folder: false, score: m.score, indices: m.indices }) }
      const dirs = new Set<string>(); for (const p of fl) { let d = dirname(p); while (d && !dirs.has(d)) { dirs.add(d); d = dirname(d) } }
      for (const d of dirs) { const m = fuzzy(q, d + '/'); if (m) scored.push({ path: d, folder: true, score: m.score - 1, indices: m.indices }) }
    } else {
      const seen = new Set<string>()
      for (const p of fl.slice(0, 400)) { const top = p.split('/')[0]; if (!seen.has(top)) { seen.add(top); scored.push({ path: top, folder: p.includes('/'), score: 0, indices: [] }) } }
    }
    scored.sort((a, b) => b.score - a.score)
    for (const s of scored.slice(0, 8)) {
      const abs = root ? root.replace(/[\\/]$/, '') + '/' + s.path : s.path
      out.push({ key: 'f:' + s.path, label: basename(s.path), detail: dirname(s.path), kind: s.folder ? 'folder' : 'file', indices: [], insert: `@${s.path} `, mention: { kind: s.folder ? 'folder' : 'file', value: abs } })
    }
    return out.slice(0, 9)
  }, [trigger, triggerId, dismissed, commands, agents, files, root])

  const pick = (it: MenuItem) => {
    if (!trigger) return
    const before = draft.text.slice(0, trigger.start), after = draft.text.slice(caret)
    const text = before + it.insert + after
    const mentions = it.mention && !draft.mentions.some(m => m.value === it.mention!.value) ? [...draft.mentions, it.mention] : draft.mentions
    set({ text, mentions })
    const pos = (before + it.insert).length
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); setCaret(pos) } })
  }

  // ── attachments
  const addImages = async (list: File[]) => {
    const got = (await Promise.all(list.map(readImage))).filter(Boolean) as ImageData[]
    if (got.length < list.length) toast.warn('Only PNG, JPEG, GIF and WebP images up to 12 MB can be attached.')
    if (got.length) set({ images: [...draft.images, ...got].slice(0, 8) })
  }
  const attachPaths = async (paths: string[]) => {
    for (const p of paths) {
      const d = await api.ai.context.describe(p)
      if (d.kind === 'image') { const b = await api.fs.readFileBase64(p); set({ images: [...(useAi.getState().drafts[key]?.images ?? []), { mime: b.mime, data: b.base64, name: basename(p) }].slice(0, 8) }) }
      else await useAi.getState().addContext(d)
    }
  }
  const pickFiles = async () => { const ps = await api.fs.pickFiles('Attach files', undefined, true); if (ps.length) await attachPaths(ps) }
  const ctxItem = (p: Omit<ContextItem, 'id' | 'enabled' | 'pinned' | 'priority' | 'auto'> & Partial<ContextItem>): ContextItem => ({ id: 'ctx-' + Date.now() + Math.random().toString(36).slice(2, 6), enabled: true, pinned: false, priority: 4, auto: false, ...p })
  const addCurrent = async (what: 'file' | 'selection' | 'terminal' | 'problems' | 'diff') => {
    const ctx = await gatherEditorContext()
    const ai = useAi.getState()
    if (what === 'file') { if (!ctx.activeFile) return void toast.warn('Open a file first.'); await ai.addContext((await api.ai.context.describe(ctx.activeFile))) }
    if (what === 'selection') { const s = ctx.selection; if (!s) return void toast.warn('Select some code in the editor first.'); await ai.addContext(ctxItem({ kind: 'selection', label: `${basename(s.path)}:${s.startLine}-${s.endLine}`, path: s.path, range: { startLine: s.startLine, endLine: s.endLine }, content: s.text, tokens: Math.ceil(s.text.length / 3.6), priority: 5 })) }
    if (what === 'terminal') { const t = ctx.terminalTail?.trim(); if (!t) return void toast.warn('The terminal has no output yet.'); await ai.addContext(ctxItem({ kind: 'terminal', label: 'Terminal output', content: t, tokens: Math.ceil(t.length / 3.6) })) }
    if (what === 'problems') { const d = useDiagnostics.getState().byPath; const lines = Object.entries(d).flatMap(([p, ds]) => ds.filter(x => x.severity === 'error' || x.severity === 'warning').map(x => `${relativeTo(root, p)}:${x.line} ${x.severity}: ${x.message.split('\n')[0]}`)).slice(0, 100); if (!lines.length) return void toast.info('No problems reported.'); await ai.addContext(ctxItem({ kind: 'diagnostics', label: `${lines.length} problems`, content: lines.join('\n'), tokens: Math.ceil(lines.join('\n').length / 3.6) })) }
    if (what === 'diff') { const t = await api.git.diffText('all').catch(() => ''); if (!t.trim()) return void toast.info('No uncommitted changes.'); const c = t.slice(0, 60_000); await ai.addContext(ctxItem({ kind: 'diff', label: 'Uncommitted changes', content: c, tokens: Math.ceil(c.length / 3.6) })) }
  }
  const addUrl = async () => {
    const u = await dialogs.prompt({ title: 'Add a web page', message: 'The page text is fetched and added to the context of this chat.', placeholder: 'https://…', confirmLabel: 'Add', validate: v => (/^https?:\/\/\S+$/i.test(v.trim()) ? null : 'Enter a full http(s) URL') })
    if (!u) return
    const t = u.trim()
    set({ mentions: [...draft.mentions, { kind: 'url', value: t }], text: (draft.text ? draft.text.trimEnd() + ' ' : '') + t + ' ' })
    taRef.current?.focus()
  }

  // ── submit
  const hasModel = models.length > 0
  const canSend = (draft.text.trim().length > 0 || draft.images.length > 0)
  const submit = async () => {
    const text = draft.text.trim()
    if (!canSend) return
    if (!hasModel && !useAi.getState().composer.model) { toast.warn('Connect an AI model first.'); useEditor.getState().openPage('models', undefined, 'Models & providers'); return }
    const slash = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text)
    if (slash) {
      const handled = await runSlash(slash[1], (slash[2] ?? '').trim())
      if (handled) return
    }
    const mentions = draft.mentions.filter(m => m.kind === 'url' || text.includes('@' + (m.kind === 'agent' ? m.value : relativeTo(root, m.value))))
    onSubmitted?.()
    if (draftKey) { set({ text: '', images: [], mentions: [] }); await useAi.getState().newChat() } // the home page always starts a fresh chat
    await useAi.getState().send(text, { images: draft.images, mentions, sessionId: sessionId ?? undefined })
  }
  const runSlash = async (name: string, args: string): Promise<boolean> => {
    const ai = useAi.getState()
    const clear = () => set({ text: '', images: [], mentions: [] })
    switch (name) {
      case 'new': case 'clear': clear(); await ai.newChat(); return true
      case 'compact': { clear(); if (!sessionId) return true; const ok = await api.ai.compact(sessionId); toast[ok ? 'success' : 'info'](ok ? 'Conversation compacted.' : 'Nothing to compact yet.'); return true }
      case 'undo': { clear(); if (!sessionId) return true; const r = await api.ai.changes.undoLastTurn(sessionId); toast[r.reverted ? 'success' : 'info'](r.reverted ? `Reverted ${r.files.length} file(s).` : 'Nothing to undo.'); return true }
      case 'redo': { clear(); if (!sessionId) return true; const r = await api.ai.changes.redo(sessionId); toast[r.applied ? 'success' : 'info'](r.applied ? `Re-applied ${r.files.length} file(s).` : 'Nothing to redo.'); return true }
      case 'export': { clear(); if (!sessionId) return true; await copyText(await api.ai.sessions.exportMarkdown(sessionId)); toast.success('Chat copied as Markdown.'); return true }
    }
    const exp = await api.commands.expand(name, args)
    if (!exp) return false
    onSubmitted?.()
    clear()
    if (draftKey) await ai.newChat()
    await ai.send(exp.text, { agent: exp.agent, sessionId: sessionId ?? undefined })
    return true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => (i + 1) % items.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => (i - 1 + items.length) % items.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(items[idx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(triggerId); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); return }
    if (e.key === 'ArrowUp' && !draft.text && sessionId) {
      const msgs = useAi.getState().data[sessionId]?.messages ?? []
      const last = [...msgs].reverse().find(m => m.role === 'user' && !m.notice)
      const t = last?.parts.find(p => p.type === 'text' && !p.synthetic)
      if (t && t.type === 'text') { e.preventDefault(); set({ text: t.text }) }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
    if (imgs.length) { e.preventDefault(); void addImages(imgs) }
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false)
    const p = e.dataTransfer.getData('application/x-tgg-path')
    if (p) { await attachPaths([p]); return }
    const fl = Array.from(e.dataTransfer.files)
    const imgs = fl.filter(f => f.type.startsWith('image/'))
    if (imgs.length) await addImages(imgs)
    const paths = fl.filter(f => !f.type.startsWith('image/')).map(f => bridge.pathForFile(f)).filter(Boolean)
    if (paths.length) await attachPaths(paths)
  }

  const ph = placeholder ?? (running ? 'Add a follow-up — it will be sent when the agent is done…' : composer.agent === 'plan' ? 'Describe what you want planned…' : 'Ask anything, @ to add files, / for commands')
  return (
    <div className={cn('composer', variant, drag && 'drag')} onDragOver={e => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-tgg-path')) { e.preventDefault(); setDrag(true) } }} onDragLeave={() => setDrag(false)} onDrop={e => void onDrop(e)}>
      {items.length > 0 && <div className="mention-menu" role="listbox">
        <div className="mm-title">{trigger?.type === '/' ? 'Commands' : 'Add to this message'}</div>
        {items.map((it, i) => <button key={it.key} role="option" aria-selected={i === idx} className={cn('mm-row', i === idx && 'on')} onMouseEnter={() => setIdx(i)} onMouseDown={e => { e.preventDefault(); pick(it) }}>
          <span className="mm-ic">{it.kind === 'agent' ? <Bot size={15} /> : it.kind === 'cmd' ? <Slash size={14} /> : it.kind === 'folder' ? <FileIcon name={it.label} dir size={16} /> : <FileIcon name={it.label} size={16} />}</span>
          <span className="mm-label truncate"><Highlight text={it.label} indices={it.kind === 'cmd' ? it.indices : []} />{it.hint && <span className="subtle"> {it.hint}</span>}</span>
          <span className={cn('mm-detail truncate', (it.kind === 'file' || it.kind === 'folder') && 'rtl')}>{it.detail}</span>
        </button>)}
      </div>}
      <div className="composer-card">
        {queue.length > 0 && <div className="queued">{queue.map((q, i) => <span key={i} className="q-chip"><Clock size={11} /><span className="truncate">{q.text}</span><button onClick={() => useAi.setState(s => ({ queue: { ...s.queue, [sessionId!]: (s.queue[sessionId!] ?? []).filter((_, j) => j !== i) } }))} aria-label="Remove queued message"><X size={11} /></button></span>)}</div>}
        {draft.images.length > 0 && <div className="attach-row">{draft.images.map((im, i) => <span key={i} className="thumb"><img src={`data:${im.mime};base64,${im.data}`} alt={im.name ?? 'image'} /><button onClick={() => set({ images: draft.images.filter((_, j) => j !== i) })} aria-label="Remove image"><X size={11} /></button></span>)}</div>}
        <textarea ref={taRef} className="composer-input" rows={variant === 'hero' ? 3 : 1} value={draft.text} placeholder={ph} spellCheck
          onChange={e => { set({ text: e.target.value }); setCaret(e.target.selectionStart); setDismissed(null) }}
          onSelect={e => setCaret((e.target as HTMLTextAreaElement).selectionStart)} onKeyDown={onKeyDown} onPaste={onPaste} aria-label="Message the agent" />
        <div className="composer-bar">
          <MenuButton icon={Plus} tip="Add context" placement="top-start" items={() => [
            { label: 'Files or images…', icon: Paperclip, onClick: () => void pickFiles() },
            { label: 'Mention a file', icon: AtSign, hint: '@', onClick: () => { set({ text: draft.text + (draft.text && !/\s$/.test(draft.text) ? ' @' : '@') }); taRef.current?.focus(); requestAnimationFrame(() => setCaret(taRef.current?.value.length ?? 0)) } },
            { separator: true },
            { label: 'Current file', icon: FileText, onClick: () => void addCurrent('file') },
            { label: 'Editor selection', icon: TextSelect, onClick: () => void addCurrent('selection') },
            { label: 'Terminal output', icon: SquareTerminal, onClick: () => void addCurrent('terminal') },
            { label: 'Problems', icon: TriangleAlert, onClick: () => void addCurrent('problems') },
            { label: 'Uncommitted changes', icon: GitCompare, onClick: () => void addCurrent('diff') },
            { label: 'Web page…', icon: Link2, onClick: () => void addUrl() }
          ]} />
          <AgentPicker value={composer.agent} onChange={a => setComposer({ agent: a })} />
          <span className="grow" />
          <ModelPicker value={composer.model} onChange={m => setComposer({ model: m })} />
          <EffortPicker value={composer.reasoning} onChange={r => setComposer({ reasoning: r })} />
          <ModePicker value={composer.mode} onChange={m => setComposer({ mode: m })} />
          {running && <button className="send-btn stop" onClick={() => void useAi.getState().abort(sessionId ?? undefined)} data-tip="Stop" data-kbd="Esc" aria-label="Stop"><Square size={12} fill="currentColor" /></button>}
          <button className="send-btn" disabled={!canSend} onClick={() => void submit()} data-tip={running ? 'Queue this message' : 'Send'} data-kbd="Enter" aria-label="Send"><ArrowUp size={16} strokeWidth={2.4} /></button>
        </div>
      </div>
    </div>
  )
}

void ImagePlus; void Folder; void Globe; void Terminal; void IconButton; void useUi; void ({} as SendRequest)
