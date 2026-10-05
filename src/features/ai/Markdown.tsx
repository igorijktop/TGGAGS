import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, FilePlus2, TextCursorInput } from 'lucide-react'
import { monaco } from '../../lib/monaco'
import { api } from '../../lib/api'
import { copyText, cn } from '../../lib/util'
import { useEditor } from '../../stores/editor'
import { useWorkspace } from '../../stores/workspace'
import { activeMonacoEditor } from '../../lib/editor-context'
import { toast, dialogs } from '../../stores/ui'

const LANG_ALIAS: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', yml: 'yaml', py: 'python', rs: 'rust', md: 'markdown', jsx: 'javascript', tsx: 'typescript', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', golang: 'go', vue: 'html', svelte: 'html', text: 'plaintext', txt: 'plaintext', console: 'shell', terminal: 'shell', dockerfile: 'dockerfile', diff: 'plaintext' }

const cache = new Map<string, string>()

/** Syntax-highlights through Monaco's tokenizer so chat code matches the editor theme. */
export function useColorized(code: string, lang: string, enabled = true): string | null {
  const key = lang + '\u0000' + code
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null)
  useEffect(() => {
    if (!enabled) return
    const hit = cache.get(key)
    if (hit) { setHtml(hit); return }
    if (code.length > 40_000) { setHtml(null); return }
    let dead = false
    const t = setTimeout(() => {
      monaco.editor.colorize(code, LANG_ALIAS[lang] ?? lang, { tabSize: 2 }).then(h => {
        if (cache.size > 400) cache.clear()
        cache.set(key, h)
        if (!dead) setHtml(h)
      }).catch(() => undefined)
    }, 60)
    return () => { dead = true; clearTimeout(t) }
  }, [key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return html
}

export function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false)
  const html = useColorized(code, lang, !streaming)
  const hasProject = useWorkspace(s => !!s.root)
  const root = useWorkspace(s => s.root)
  const copy = async () => { await copyText(code); setCopied(true); setTimeout(() => setCopied(false), 1400) }
  const insert = () => {
    const ed = activeMonacoEditor()
    if (!ed) { toast.warn('Open a file in the editor first.'); return }
    const sel = ed.getSelection()
    if (!sel) return
    ed.executeEdits('chat-insert', [{ range: sel, text: code, forceMoveMarkers: true }])
    ed.focus()
  }
  const toFile = async () => {
    if (!root) { toast.warn('Open a project folder first.'); return }
    const name = await dialogs.prompt({ title: 'Create file from code', message: 'File path relative to the project root.', placeholder: 'src/example.ts', confirmLabel: 'Create' })
    if (!name) return
    const abs = root.replace(/[\\/]$/, '') + '/' + name.replace(/^[\\/]+/, '')
    try { await api.fs.createFile(abs, code); await useEditor.getState().openFile(abs) } catch (e) { toast.error((e as Error).message) }
  }
  const label = lang && lang !== 'plaintext' ? lang : 'text'
  return (
    <div className="codeblock selectable">
      <div className="cb-head">
        <span className="cb-lang">{label}</span>
        <span className="grow" />
        {hasProject && <button className="cb-btn" onClick={toFile} data-tip="Create a file from this code"><FilePlus2 size={13} /></button>}
        <button className="cb-btn" onClick={insert} data-tip="Insert at cursor in the editor"><TextCursorInput size={13} /></button>
        <button className="cb-btn" onClick={copy} data-tip="Copy">{copied ? <Check size={13} /> : <Copy size={13} />}{copied && <span>Copied</span>}</button>
      </div>
      {html ? <pre className="cb-body" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="cb-body">{code}</pre>}
    </div>
  )
}

const PATH_RE = /^(?:[A-Za-z]:)?[\w@.\-/\\]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

function openPathRef(ref: string, root: string | null | undefined) {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(ref)
  if (!m) return
  let p = m[1]
  if (!/^([A-Za-z]:)?[\\/]/.test(p) && root) p = root.replace(/[\\/]$/, '') + '/' + p
  void useEditor.getState().openFile(p, { line: m[2] ? +m[2] : undefined, col: m[3] ? +m[3] : undefined })
}

function MarkdownImpl({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  const root = useWorkspace(s => s.root)
  const components = useMemo(() => ({
    code({ className: cls, children }: { className?: string; children?: ReactNode }) {
      const raw = String(children ?? '')
      const m = /language-([\w+#.-]+)/.exec(cls ?? '')
      if (!m && !raw.includes('\n')) {
        const t = raw.trim()
        if (PATH_RE.test(t) && !t.startsWith('http')) return <code className="inline-code path" onClick={() => openPathRef(t, root)} title="Open file">{raw}</code>
        return <code className="inline-code">{raw}</code>
      }
      return <CodeBlock code={raw.replace(/\n$/, '')} lang={(m?.[1] ?? '').toLowerCase()} streaming={streaming} />
    },
    pre({ children }: { children?: ReactNode }) { return <>{children}</> },
    a({ href, children }: { href?: string; children?: ReactNode }) {
      return <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/i.test(href)) void api.fs.openExternal(href) }} title={href}>{children}</a>
    },
    table({ children }: { children?: ReactNode }) { return <div className="md-table"><table>{children}</table></div> },
    input({ checked }: { checked?: boolean }) { return <span className={cn('md-check', checked && 'on')}>{checked && <Check size={10} strokeWidth={3.5} />}</span> }
  }), [root, streaming])
  return <div className={cn('md selectable', className)}><ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>{text}</ReactMarkdown></div>
}

export const Markdown = memo(MarkdownImpl)
