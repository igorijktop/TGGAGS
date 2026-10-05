import { useEffect, useState } from 'react'
import { ChevronRight, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { PermissionAction, PermissionRule } from '@shared/settings'
import { api } from '../../lib/api'
import { cn, uid } from '../../lib/util'
import { Button, IconButton } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { useAi } from '../../stores/ai'
import { Group, Row, SelectField, TextField } from './rows'

const CATEGORIES = ['read', 'edit', 'shell', 'git', 'web', 'subagent', 'skill', 'lsp', 'mcp', 'plugin', 'image', 'external_api', 'external_dir', 'memory', 'todo', 'question', 'custom', '*']
const ACTIONS: { value: PermissionAction; label: string }[] = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask me' }, { value: 'deny', label: 'Deny' }]
const HINT: Record<string, string> = { read: 'file path, e.g. **/.env', edit: 'file path, e.g. src/**', shell: 'command, e.g. npm test*', git: 'git sub-command, e.g. push*', web: 'domain, e.g. github.com', mcp: 'tool id, e.g. mcp__github__*' }

function ActionBadge({ a }: { a: PermissionAction }) { return <span className={cn('badge', a === 'allow' ? 'success' : a === 'deny' ? 'danger' : 'warning')}>{a === 'ask' ? 'Ask' : a === 'allow' ? 'Allow' : 'Deny'}</span> }

export function PermissionsSection() {
  const rules = useSettings(s => s.settings.permissions.rules)
  const setSection = useSettings(s => s.setSection)
  const agents = useAi(s => s.agents)
  const [defaults, setDefaults] = useState<PermissionRule[]>([])
  const [showDefaults, setShowDefaults] = useState(false)
  useEffect(() => { void api.permissions.defaults().then(setDefaults) }, [])
  const save = (next: PermissionRule[]) => void setSection('permissions', { rules: next })
  const patch = (id: string, p: Partial<PermissionRule>) => save(rules.map(r => (r.id === id ? { ...r, ...p } : r)))
  const add = () => save([...rules, { id: uid('rule-'), tool: 'shell', pattern: '', action: 'ask' }])
  return <>
    <Group title="How decisions are made" hint="Every request is checked against the built-in defaults, then your rules, then the agent’s own rules. The last rule that matches wins — so a rule you add always overrides a default.">
      <Row title={<span className="row gap8"><ShieldCheck size={15} className="accent-ic" />Your rules</span>} description="Allow, ask or deny by tool category, file path, command, domain or agent." stack>
        {rules.length === 0 && <div className="subtle small" style={{ padding: '4px 0' }}>No custom rules yet. Rules you create with “Always allow” in a permission prompt show up here.</div>}
        <div className="rule-list">
          {rules.map(r => <div key={r.id} className="rule-row">
            <SelectField width={118} value={r.tool} options={[...new Set([...CATEGORIES, r.tool])].map(c => ({ value: c, label: c === '*' ? 'Anything' : c }))} onChange={v => patch(r.id, { tool: v })} />
            <TextField width="100%" mono value={r.pattern ?? ''} placeholder={HINT[r.tool] ?? 'pattern (optional)'} onChange={v => patch(r.id, { pattern: v.trim() || undefined })} />
            <SelectField width={104} value={r.agent ?? ''} options={[{ value: '', label: 'Any agent' }, ...agents.map(a => ({ value: a.id, label: a.name }))]} onChange={v => patch(r.id, { agent: v || undefined })} />
            <SelectField width={96} value={r.action} options={ACTIONS} onChange={v => patch(r.id, { action: v })} />
            <IconButton icon={Trash2} size="sm" tip="Remove rule" onClick={() => save(rules.filter(x => x.id !== r.id))} />
          </div>)}
        </div>
        <div className="row gap8" style={{ marginTop: 8 }}><Button size="sm" icon={Plus} onClick={add}>Add rule</Button>{rules.length > 0 && <Button size="sm" variant="ghost" onClick={() => save([])}>Remove all</Button>}</div>
      </Row>
    </Group>
    <Group title="Built-in defaults">
      <Row title="Safe by default" description="Reading is allowed (except secrets like .env), edits and shell commands ask first, harmless commands such as git status or npm test run without asking, and destructive commands are always blocked."><Button size="sm" variant="ghost" onClick={() => setShowDefaults(!showDefaults)}><ChevronRight size={13} className={cn('t-chev', showDefaults && 'open')} />{showDefaults ? 'Hide' : 'Show'} {defaults.length} rules</Button></Row>
      {showDefaults && <div className="rule-defaults">{defaults.map(r => <div key={r.id} className="rule-def"><ActionBadge a={r.action} /><span className="mono small">{r.tool}</span><span className="mono small subtle truncate grow">{r.pattern ?? ''}</span>{r.note && <span className="subtle small truncate">{r.note}</span>}</div>)}</div>}
    </Group>
  </>
}
