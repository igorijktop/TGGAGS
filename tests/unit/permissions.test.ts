import { describe, expect, it } from 'vitest'
import { applyMode, evaluate } from '../../electron/ai/permissions'
import { defaultPermissionRules, type PermissionRule } from '../../shared/settings'
import { parseCommand, gitSubcommand } from '../../electron/ai/tools/shellparse'

const rules = defaultPermissionRules()
const base = { agentId: 'build' }

describe('permission rules', () => {
  it('allows reading project files but denies .env', () => {
    expect(evaluate(rules, [], { ...base, toolName: 'read', category: 'read', resource: 'src/a.ts', isPath: true }).action).toBe('allow')
    expect(evaluate(rules, [], { ...base, toolName: 'read', category: 'read', resource: '.env', isPath: true }).action).toBe('deny')
    expect(evaluate(rules, [], { ...base, toolName: 'read', category: 'read', resource: 'config/.env.production', isPath: true }).action).toBe('deny')
    expect(evaluate(rules, [], { ...base, toolName: 'read', category: 'read', resource: '.env.example', isPath: true }).action).toBe('allow')
  })
  it('last matching rule wins; grants only upgrade ask', () => {
    const user: PermissionRule[] = [{ id: 'u', tool: 'edit', pattern: 'src/**', action: 'allow' }]
    expect(evaluate([...rules, ...user], [], { ...base, toolName: 'edit', category: 'edit', resource: 'src/x.ts', isPath: true }).action).toBe('allow')
    expect(evaluate(rules, [], { ...base, toolName: 'edit', category: 'edit', resource: 'src/x.ts', isPath: true }).action).toBe('ask')
    const grant: PermissionRule[] = [{ id: 'g', tool: 'edit', pattern: 'src/**', action: 'allow' }]
    expect(evaluate(rules, grant, { ...base, toolName: 'edit', category: 'edit', resource: 'src/x.ts', isPath: true }).action).toBe('allow')
    expect(evaluate(rules, [{ id: 'g2', tool: 'edit', pattern: '**', action: 'allow' }], { ...base, toolName: 'edit', category: 'edit', resource: '.env', isPath: true }).action).toBe('deny')
  })
  it('matches shell commands by wildcard', () => {
    const ev = (c: string) => evaluate(rules, [], { ...base, toolName: 'shell', category: 'shell', resource: c, isPath: false }).action
    expect(ev('git status')).toBe('allow')
    expect(ev('git status --short')).toBe('allow')
    expect(ev('npm test')).toBe('allow')
    expect(ev('npm install left-pad')).toBe('ask')
    expect(ev('rm -rf /')).toBe('deny')
    expect(ev('cat .env')).toBe('ask')
  })
  it('git category rules', () => {
    const ev = (c: string) => evaluate(rules, [], { ...base, toolName: 'shell', category: 'git', resource: c, isPath: false }).action
    expect(ev('status --short')).toBe('allow')
    expect(ev('push origin main')).toBe('ask')
    const denyPush: PermissionRule[] = [{ id: 'd', tool: 'git', pattern: 'push*', action: 'deny' }]
    expect(evaluate([...rules, ...denyPush], [], { ...base, toolName: 'shell', category: 'git', resource: 'push origin main', isPath: false }).action).toBe('deny')
  })
  it('matches web rules by domain including subdomains', () => {
    const r: PermissionRule[] = [{ id: 'w', tool: 'web', pattern: 'github.com', action: 'allow' }]
    expect(evaluate([...rules, ...r], [], { ...base, toolName: 'webfetch', category: 'web', resource: 'api.github.com', isPath: false }).action).toBe('allow')
    expect(evaluate([...rules, ...r], [], { ...base, toolName: 'webfetch', category: 'web', resource: 'evil.com', isPath: false }).action).toBe('ask')
  })
  it('agent-scoped rules apply only to that agent', () => {
    const r: PermissionRule[] = [{ id: 'a', tool: 'shell', pattern: 'make*', action: 'allow', agent: 'tester' }]
    expect(evaluate([...rules, ...r], [], { agentId: 'tester', toolName: 'shell', category: 'shell', resource: 'make test', isPath: false }).action).toBe('allow')
    expect(evaluate([...rules, ...r], [], { agentId: 'build', toolName: 'shell', category: 'shell', resource: 'make test', isPath: false }).action).toBe('ask')
  })
})

describe('permission modes', () => {
  it('auto-edit allows project edits, plan denies them, yolo allows asks but never denies', () => {
    expect(applyMode('auto-edit', { action: 'ask' }, 'edit', true).action).toBe('allow')
    expect(applyMode('auto-edit', { action: 'ask' }, 'edit', false).action).toBe('ask')
    expect(applyMode('auto-edit', { action: 'ask' }, 'shell', true).action).toBe('ask')
    expect(applyMode('plan', { action: 'allow' }, 'edit', true).action).toBe('deny')
    expect(applyMode('plan', { action: 'ask' }, 'shell', true).action).toBe('deny')
    expect(applyMode('plan', { action: 'allow' }, 'read', true).action).toBe('allow')
    expect(applyMode('yolo', { action: 'ask' }, 'shell', true).action).toBe('allow')
    expect(applyMode('yolo', { action: 'deny' }, 'shell', true).action).toBe('deny')
  })
})

describe('command parsing', () => {
  it('splits compound commands and flags risky constructs', () => {
    expect(parseCommand('npm test && git status; ls | wc -l').segments).toEqual(['npm test', 'git status', 'ls', 'wc -l'])
    expect(parseCommand('echo hi > out.txt').risky).toBe(true)
    expect(parseCommand('echo hi 2>&1').risky).toBe(false)
    expect(parseCommand('cat $(whoami)').risky).toBe(true)
    expect(parseCommand('echo "a && b"').segments).toEqual(['echo "a && b"'])
  })
  it('extracts git subcommands', () => {
    expect(gitSubcommand('git -C repo --no-pager log --oneline')?.rest).toBe('log --oneline')
    expect(gitSubcommand('npm run git')).toBeNull()
  })
})
