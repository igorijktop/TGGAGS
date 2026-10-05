import { useEffect, useRef } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { api, onEvent } from '../../lib/api'
import { toHex } from '../../lib/theme'
import { useSettings } from '../../stores/settings'

const ANSI_LIGHT = { black: '#2A2925', red: '#C23B31', green: '#2F7D4F', yellow: '#B26B00', blue: '#2563A8', magenta: '#8A3FC0', cyan: '#1C6B86', white: '#8C8777', brightBlack: '#68655D', brightRed: '#D9534A', brightGreen: '#3B9A62', brightYellow: '#C98A1A', brightBlue: '#3B7BC4', brightMagenta: '#A55BD8', brightCyan: '#2A8AA8', brightWhite: '#C9C5BA' }
const ANSI_DARK = { black: '#3A3935', red: '#F0776D', green: '#6FC28B', yellow: '#E3A93E', blue: '#7AAEF0', magenta: '#C792EA', cyan: '#7EC4DA', white: '#D8D5CB', brightBlack: '#827E73', brightRed: '#F79A92', brightGreen: '#8FD6A5', brightYellow: '#EFC265', brightBlue: '#9CC3F6', brightMagenta: '#D7ADF2', brightCyan: '#A1D7E8', brightWhite: '#F2F0E9' }

export function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim()
  const dark = document.documentElement.dataset.kind === 'dark'
  return { background: toHex(v('--bg')), foreground: toHex(v('--fg')), cursor: toHex(v('--accent')), cursorAccent: toHex(v('--bg')), selectionBackground: toHex(v('--selection')), ...(dark ? ANSI_DARK : ANSI_LIGHT) }
}

/** One xterm instance bound to a main-process terminal. Kept mounted (hidden) so scrollback and state survive tab switches. */
export function TerminalView({ id, visible, focusKey }: { id: string; visible: boolean; focusKey: number }) {
  const host = useRef<HTMLDivElement>(null)
  const ref = useRef<{ term: XTerm; fit: FitAddon; search: SearchAddon } | null>(null)
  const settings = useSettings(s => s.settings.terminal)
  const theme = useSettings(s => s.settings.appearance.theme)

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace", fontSize: settings.fontSize, cursorBlink: true, cursorStyle: settings.cursorStyle, scrollback: settings.scrollback,
      allowProposedApi: true, theme: terminalTheme(), macOptionIsMeta: true, rightClickSelectsWord: true, smoothScrollDuration: 0
    })
    const fit = new FitAddon(), search = new SearchAddon()
    term.loadAddon(fit); term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => { void api.fs.openExternal(uri) }))
    term.open(host.current!)
    ref.current = { term, fit, search }
    let disposed = false
    const doFit = () => { try { fit.fit(); void api.terminal.resize(id, term.cols, term.rows) } catch { /* hidden */ } }
    void api.terminal.buffer(id).then(b => { if (!disposed && b) term.write(b) }).finally(() => { if (!disposed) doFit() })
    const off = onEvent('terminal:data', d => { if (d.id === id) term.write(d.data) })
    const dd = term.onData(d => { void api.terminal.write(id, d) })
    term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.code === 'KeyC') { void navigator.clipboard.writeText(term.getSelection()); return false }
      if (mod && e.shiftKey && e.code === 'KeyV') { void navigator.clipboard.readText().then(t => term.paste(t)); return false }
      if (e.ctrlKey && e.code === 'KeyC' && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false }
      return true
    })
    const sel = term.onSelectionChange(() => { if (useSettings.getState().settings.terminal.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()) })
    const ro = new ResizeObserver(() => { if (host.current && host.current.offsetParent !== null) doFit() })
    ro.observe(host.current!)
    return () => { disposed = true; off(); dd.dispose(); sel.dispose(); ro.disconnect(); term.dispose(); ref.current = null }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = ref.current?.term
    if (!t) return
    t.options.fontSize = settings.fontSize; t.options.cursorStyle = settings.cursorStyle; t.options.scrollback = settings.scrollback
    try { ref.current!.fit.fit(); void api.terminal.resize(id, t.cols, t.rows) } catch { /* ignore */ }
  }, [settings.fontSize, settings.cursorStyle, settings.scrollback, id])
  useEffect(() => { requestAnimationFrame(() => { if (ref.current) ref.current.term.options.theme = terminalTheme() }) }, [theme])
  useEffect(() => { if (visible && ref.current) { requestAnimationFrame(() => { try { ref.current!.fit.fit(); void api.terminal.resize(id, ref.current!.term.cols, ref.current!.term.rows) } catch { /* ignore */ } ref.current?.term.focus() }) } }, [visible, focusKey, id])

  return <div className="term-host" ref={host} style={{ display: visible ? 'block' : 'none' }} />
}
