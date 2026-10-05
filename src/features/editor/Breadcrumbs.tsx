import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useWorkspace } from '../../stores/workspace'
import { useEditor, type Tab } from '../../stores/editor'
import { useSettings } from '../../stores/settings'
import { relativeTo, joinPath, dirname, debounce } from '../../lib/util'
import { activeMonacoEditor } from '../../lib/editor-context'
import { FileIcon } from '../../lib/icons'
import { Menu } from '../../components/ui'
import type { FileEntry } from '@shared/fs'
import type { LspSymbol } from '@shared/dev'

function symbolChain(list: LspSymbol[], line: number): LspSymbol[] {
  for (const s of list) if (line >= s.line && line <= s.endLine) return [s, ...(s.children ? symbolChain(s.children, line) : [])]
  return []
}

export function Breadcrumbs({ tab }: { tab: Tab }) {
  const root = useWorkspace(s => s.root)
  const enabled = useSettings(s => s.settings.editor.breadcrumbs)
  const [symbols, setSymbols] = useState<LspSymbol[]>([])
  const [chain, setChain] = useState<LspSymbol[]>([])
  const [menu, setMenu] = useState<{ el: HTMLElement; entries: FileEntry[]; dir: string } | null>(null)
  const line = useEditor(s => s.status.line)
  const path = tab.path!

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = debounce(() => { void api.lsp.documentSymbols(path).then(s => { if (!cancelled) setSymbols(s) }).catch(() => undefined) }, 600)
    load()
    const ed = activeMonacoEditor(); const sub = ed?.onDidChangeModelContent(() => load())
    return () => { cancelled = true; load.cancel(); sub?.dispose() }
  }, [path, enabled])
  useEffect(() => { setChain(symbolChain(symbols, line)) }, [symbols, line])

  if (!enabled) return null
  const rel = relativeTo(root, path).split('/')
  const base = root && path.toLowerCase().startsWith(root.toLowerCase()) ? root : dirname(path)
  const showDir = async (el: HTMLElement, i: number) => {
    const dir = joinPath(base, rel.slice(0, i + 1).join('/'))
    const entries = await api.fs.readDir(i === rel.length - 1 ? dirname(path) : dir).catch(() => [])
    setMenu({ el, entries, dir })
  }
  return (
    <div className="breadcrumbs">
      {rel.map((seg, i) => (
        <span key={i} className="row">
          <button className={`crumb${i === rel.length - 1 && !chain.length ? ' last' : ''}`} onClick={e => void showDir(e.currentTarget, i)}>{i === rel.length - 1 && <FileIcon name={seg} size={13} />}{seg}</button>
          {(i < rel.length - 1 || chain.length > 0) && <ChevronRight size={12} className="sep" />}
        </span>
      ))}
      {chain.map((s, i) => (
        <span key={i} className="row">
          <button className={`crumb${i === chain.length - 1 ? ' last' : ''}`} onClick={() => { const ed = activeMonacoEditor(); ed?.revealLineInCenter(s.line); ed?.setPosition({ lineNumber: s.line, column: s.col }); ed?.focus() }}><span className="subtle tiny">{s.kind}</span> {s.name}</button>
          {i < chain.length - 1 && <ChevronRight size={12} className="sep" />}
        </span>
      ))}
      {menu && <Menu anchor={menu.el} onClose={() => setMenu(null)} items={menu.entries.slice(0, 80).map(e => ({ label: e.name + (e.isDir ? '/' : ''), onClick: () => { if (!e.isDir) void useEditor.getState().openFile(e.path, { pin: true }) } }))} />}
    </div>
  )
}
