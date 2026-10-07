import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Bell, Bug, CheckCircle2, GitBranch, RefreshCw, Sparkles, Loader } from 'lucide-react'
import { monaco } from '../../lib/monaco'
import { api } from '../../lib/api'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useUi } from '../../stores/ui'
import { useAi } from '../../stores/ai'
import { useSettings } from '../../stores/settings'
import { useDiagnostics } from '../../lib/lsp-monaco'
import { useDebug } from '../../stores/debug'
import { MenuButton } from '../../components/ui'
import { runCommand } from '../../lib/commands'
import { activeMonacoEditor } from '../../lib/editor-context'
import { formatTokens } from '../../lib/util'
import { useLspStatus } from '../../stores/lsp'
import { revealChat } from '../../lib/chat-nav'

export function StatusBar() {
  const git = useGit(s => s.status)
  const busy = useGit(s => s.busy)
  const st = useEditor(s => s.status)
  const diag = useDiagnostics()
  const ui = useUi()
  const dbg = useDebug(s => s.snapshot)
  const ai = useAi()
  const model = useSettings(s => s.settings.ai.defaultModel)
  const providers = useSettings(s => s.settings.providers)
  const lsp = useLspStatus(s => s.servers)
  const ctx = ai.active ? ai.context[ai.active] : undefined
  const modelName = (() => { const m = ai.composer.model ?? model; if (!m) return null; const p = providers.find(x => x.id === m.provider); return p?.models.find(x => x.id === m.model)?.name ?? m.model })()
  const running = ai.active ? ai.running[ai.active] : false
  const ts = lsp.find(s => s.id === 'typescript')
  const setLang = () => {
    const ed = activeMonacoEditor(); const model = ed?.getModel()
    if (!model) return []
    return monaco.languages.getLanguages().sort((a, b) => (a.aliases?.[0] ?? a.id).localeCompare(b.aliases?.[0] ?? b.id)).map(l => ({ label: l.aliases?.[0] ?? l.id, checked: l.id === model.getLanguageId(), onClick: () => { monaco.editor.setModelLanguage(model, l.id); useEditor.getState().setStatus({ language: l.id }) } }))
  }
  return (
    <div className="statusbar">
      {git?.isRepo && <button className="status-item" onClick={() => runCommand('git.checkout')} data-tip="Switch branch"><GitBranch size={13} />{git.branch ?? `(${git.head ?? 'detached'})`}{(git.merging || git.rebasing) && <span className="warn" style={{ color: 'var(--warning)' }}>{git.merging ? 'merging' : 'rebasing'}</span>}</button>}
      {git?.isRepo && (git.upstream || git.ahead > 0 || git.behind > 0) && <button className="status-item" data-tip={`${git.ahead} to push · ${git.behind} to pull — click to sync`} onClick={() => runCommand('git.sync')}>{busy ? <RefreshCw size={12} className="spin-anim" /> : <RefreshCw size={12} />}{(git.ahead > 0 || git.behind > 0) && <>{git.behind}<ArrowDown size={11} />{git.ahead}<ArrowUp size={11} /></>}</button>}
      <button className={`status-item ${diag.errors ? 'err' : ''}`} onClick={() => ui.togglePanel('problems')} data-tip="Problems"><AlertCircle size={13} />{diag.errors}<AlertTriangle size={13} style={{ marginLeft: 4 }} className={diag.warnings ? 'warn' : ''} />{diag.warnings}</button>
      {ts && <button className={`status-item ${ts.state === 'error' ? 'err' : ''}`} data-tip={`TypeScript / JavaScript language service: ${ts.state}${ts.message ? ' — ' + ts.message : ''}`} onClick={() => runCommand('settings.languages')}>{ts.state === 'running' ? <CheckCircle2 size={12} /> : ts.state === 'error' ? <AlertCircle size={12} /> : <Loader size={12} />}TS</button>}
      {dbg.state !== 'inactive' && <button className="status-item accent" onClick={() => ui.togglePanel('debug')}><Bug size={13} />{dbg.state === 'paused' ? 'Paused' : dbg.state === 'terminated' ? 'Finished' : 'Debugging'}</button>}
      <div className="sb-sep" />
      {st.path && <>
        <button className="status-item" data-tip="Go to line" onClick={() => runCommand('palette.goToLine')}>Ln {st.line}, Col {st.col}{st.selected > 0 && <span className="muted"> ({st.selected} selected)</span>}</button>
        <MenuButton variant="ghost" className="status-item" tip="Indentation" items={() => [2, 4, 8].flatMap(n => [{ label: `Spaces: ${n}`, checked: st.insertSpaces && st.tabSize === n, onClick: () => applyIndent(n, true) }]).concat([{ label: 'Tabs', checked: !st.insertSpaces, onClick: () => applyIndent(st.tabSize, false) }])}>{st.insertSpaces ? `Spaces: ${st.tabSize}` : `Tab: ${st.tabSize}`}</MenuButton>
        <span className="status-item">{st.encoding}</span>
        <MenuButton variant="ghost" className="status-item" tip="End of line sequence" items={[{ label: 'LF', checked: st.eol === 'LF', onClick: () => setEol('LF') }, { label: 'CRLF', checked: st.eol === 'CRLF', onClick: () => setEol('CRLF') }]}>{st.eol}</MenuButton>
        <MenuButton variant="ghost" className="status-item" tip="Language mode" items={setLang}>{monaco.languages.getLanguages().find(l => l.id === st.language)?.aliases?.[0] ?? st.language}</MenuButton>
      </>}
      <button className="status-item" onClick={() => revealChat()} data-tip={modelName ? 'AI model' : 'No AI model configured'}>
        {running ? <Loader size={12} className="spin-anim" /> : <Sparkles size={13} />}{modelName ?? 'Connect a model'}
        {ctx && <span className="muted">{formatTokens(ctx.used)} / {formatTokens(ctx.window)}</span>}
      </button>
      <button className="status-item" data-tip="Notifications" onClick={() => runCommand('view.notifications')}><Bell size={13} />{ui.notifications.length > 0 && ui.notifications.length}</button>
    </div>
  )
}

function applyIndent(n: number, spaces: boolean) {
  const ed = activeMonacoEditor()
  ed?.getModel()?.updateOptions({ tabSize: n, insertSpaces: spaces, indentSize: n })
  useEditor.getState().setStatus({ tabSize: n, insertSpaces: spaces })
}
function setEol(e: 'LF' | 'CRLF') {
  const ed = activeMonacoEditor()
  ed?.getModel()?.pushEOL(e === 'LF' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF)
  useEditor.getState().setStatus({ eol: e })
}
void api
