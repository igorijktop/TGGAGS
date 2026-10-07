import { useEffect, useState } from 'react'
import { FolderOpen, Puzzle, RefreshCw, Trash2 } from 'lucide-react'
import type { ExtensionInfo } from '@shared/ext'
import { api, onEvent } from '../../lib/api'
import { Badge, Button, EmptyState, Switch } from '../../components/ui'
import { dialogs, toast } from '../../stores/ui'
import { useEditor } from '../../stores/editor'
import { Group, Row } from '../settings/rows'

export function ExtensionPage({ id }: { id: string }) {
  const [ext, setExt] = useState<ExtensionInfo | null | undefined>(undefined)
  const load = () => void api.extensions.list().then(l => setExt(l.find(e => e.id === id) ?? null))
  useEffect(() => { load(); return onEvent('ext:changed', load) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (ext === undefined) return null
  if (ext === null) return <div className="page-scroll"><EmptyState icon={Puzzle} title="Extension not found" text="It may have been uninstalled." /></div>
  const m = ext.manifest
  const c = m.contributes ?? {}
  return <div className="page-scroll"><div className="page narrow">
    <div className="page-head"><div><div className="row gap8"><h1 className="serif">{m.name}</h1><span className="subtle">v{m.version}</span></div><p className="page-sub">{m.description}{m.author ? ` — by ${m.author}` : ''}</p></div>
      <div className="row gap8"><span className="small muted">Enabled</span><Switch on={ext.enabled} onChange={async v => { await api.extensions.setEnabled(id, v); load() }} />
        <Button icon={FolderOpen} onClick={() => void api.fs.reveal(ext.dir)}>Show folder</Button>
        {ext.scope !== 'bundled' && <Button variant="danger" icon={Trash2} onClick={async () => { if (await dialogs.confirm({ title: `Uninstall ${m.name}?`, confirmLabel: 'Uninstall', danger: true })) { await api.extensions.uninstall(id); toast.success('Uninstalled.'); useEditor.getState().openPage('chat') } }}>Uninstall</Button>}</div></div>
    {ext.error && <div className="msg-error big"><span className="selectable">{ext.error}</span><Button size="sm" icon={RefreshCw} onClick={() => void api.extensions.reload()}>Reload</Button></div>}
    <Group title="About"><Row title="Identifier"><span className="mono small">{m.id}</span></Row><Row title="Installed for"><Badge>{ext.scope === 'bundled' ? 'Built in' : ext.scope === 'global' ? 'All projects' : 'This project'}</Badge></Row><Row title="Status"><Badge kind={ext.active ? 'success' : ext.enabled ? 'warning' : undefined}>{ext.active ? 'Running' : ext.enabled ? 'Not active' : 'Disabled'}</Badge></Row>
      {m.permissions?.length ? <Row title="Permissions requested" description="What this extension is allowed to do."><span className="row gap4" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>{m.permissions.map(p => <Badge key={p} kind="warning">{p}</Badge>)}</span></Row> : null}
      {m.homepage && <Row title="Homepage"><button className="link-btn" onClick={() => void api.fs.openExternal(m.homepage!)}>{m.homepage}</button></Row>}</Group>
    {(c.tools?.length ?? 0) > 0 && <Group title="Tools for the agent">{c.tools!.map(t => <Row key={t.name} title={<span className="mono">{t.name}</span>} description={t.description} />)}</Group>}
    {(c.commands?.length ?? 0) > 0 && <Group title="Slash commands">{c.commands!.map(t => <Row key={t.name} title={<span className="mono">/{t.name}</span>} description={t.description} />)}</Group>}
    {(c.themes?.length ?? 0) > 0 && <Group title="Colour themes">{c.themes!.map(t => <Row key={t.id} title={t.name} description={t.kind === 'dark' ? 'Dark' : 'Light'}><Button size="sm" onClick={() => void import('../../stores/settings').then(s => s.useSettings.getState().update({ appearance: { theme: t.id } } as never))}>Use theme</Button></Row>)}</Group>}
    {Object.keys(c.mcpServers ?? {}).length > 0 && <Group title="MCP servers">{Object.entries(c.mcpServers!).map(([n, cfg]) => <Row key={n} title={n} description={cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(' ')} />)}</Group>}
  </div></div>
}
