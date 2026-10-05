// Skills, slash commands, project instructions and persistent memory – small file-backed services.
import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CommandInfo, MemoryState, SkillInfo } from '../../shared/ai'
import { parseFrontmatter } from './frontmatter'
import { dataPath, PROJECT_DIR, dataDir } from '../services/paths'

const home = () => process.env.USERPROFILE || process.env.HOME || ''

// ───────────── Skills ─────────────
function skillDirs(root: string | null): { dir: string; source: SkillInfo['source'] }[] {
  const out: { dir: string; source: SkillInfo['source'] }[] = []
  if (root) for (const d of [join(root, PROJECT_DIR, 'skills'), join(root, '.claude', 'skills'), join(root, '.agents', 'skills')]) out.push({ dir: d, source: 'project' })
  out.push({ dir: dataPath('skills'), source: 'global' })
  if (home()) out.push({ dir: join(home(), '.claude', 'skills'), source: 'global' })
  return out
}

export async function listSkills(root: string | null): Promise<SkillInfo[]> {
  const seen = new Map<string, SkillInfo>()
  for (const { dir, source } of skillDirs(root)) {
    let entries: string[] = []
    try { entries = await fsp.readdir(dir) } catch { continue }
    for (const e of entries) {
      const file = join(dir, e, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        const { data, body } = parseFrontmatter(await fsp.readFile(file, 'utf8'))
        const name = String(data.name ?? e)
        if (seen.has(name)) continue
        const desc = String(data.description ?? body.trim().split('\n')[0] ?? '').slice(0, 300)
        seen.set(name, { name, description: desc, path: file, source })
      } catch { /* skip */ }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadSkill(root: string | null, name: string): Promise<{ name: string; content: string; dir: string; files: string[] } | null> {
  const s = (await listSkills(root)).find(x => x.name === name)
  if (!s) return null
  const { body } = parseFrontmatter(await fsp.readFile(s.path, 'utf8'))
  const dir = dirname(s.path)
  let files: string[] = []
  try { files = (await fsp.readdir(dir, { recursive: true })).map(String).filter(f => basename(f) !== 'SKILL.md' && !f.includes('node_modules')).slice(0, 60) } catch { /* none */ }
  return { name: s.name, content: body.trim(), dir, files }
}

// ───────────── Commands ─────────────
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: 'init', description: 'Analyse the project and create or improve AGENTS.md', source: 'builtin', template: 'Analyse this codebase (structure, languages, build/test/lint commands, conventions, architecture) and create or update an AGENTS.md file at the project root that tells future AI agents how to work here. Keep it under ~80 lines, concrete and specific to this repo. If AGENTS.md already exists, improve it rather than replacing it. $ARGUMENTS' },
  { name: 'review', description: 'Review the current uncommitted changes (or a given target)', source: 'builtin', agent: 'build', hint: '[target]', template: 'Review $ARGUMENTS. If no target is given, review the current uncommitted changes (git diff and git diff --staged). Use the reviewer sub-agent for a thorough review of larger changes, then summarise the findings by severity with file:line references. Do not modify files.' },
  { name: 'explain', description: 'Explain a file, function or concept in this codebase', source: 'builtin', hint: '<what>', agent: 'build', template: 'Explain $ARGUMENTS in the context of this codebase. Read the relevant code first. Give a clear overview, how the pieces interact, and call out anything surprising. Do not modify files.' },
  { name: 'fix', description: 'Find and fix a bug or failing test', source: 'builtin', hint: '<problem>', template: 'Find the root cause of this problem and fix it: $ARGUMENTS\nReproduce it first if possible, make the minimal fix, then run the relevant tests/build to verify.' },
  { name: 'test', description: 'Write and run tests for something', source: 'builtin', hint: '<target>', template: 'Write thorough automated tests for $ARGUMENTS following the project’s existing test setup, then run them and report the results. Delegate to the tester sub-agent if the scope is large.' },
  { name: 'commit', description: 'Draft a commit message for the current changes', source: 'builtin', template: 'Look at the current git changes (git status, git diff, git diff --staged, and recent git log for message style) and write a clear commit message. Show it to me; only run git commit if I explicitly ask. $ARGUMENTS' },
  { name: 'docs', description: 'Update documentation to match the code', source: 'builtin', hint: '[scope]', template: 'Update the documentation (README, docs, docstrings) so it matches the current code. Scope: $ARGUMENTS. Verify commands and examples by running them where possible.' },
  { name: 'security', description: 'Security review of the project or a path', source: 'builtin', hint: '[path]', template: 'Perform a security review of $ARGUMENTS (default: the whole project). Use the security sub-agent and report findings with severity, location and remediation.' },
  { name: 'plan', description: 'Create an implementation plan without changing anything', source: 'builtin', agent: 'plan', hint: '<task>', template: '$ARGUMENTS' },
  { name: 'refactor', description: 'Refactor code while keeping behaviour', source: 'builtin', hint: '<target>', template: 'Refactor $ARGUMENTS to improve clarity and structure without changing behaviour. Make sure tests pass before and after; add tests first if coverage is missing.' }
]

async function loadCommandDir(dir: string, source: CommandInfo['source']): Promise<CommandInfo[]> {
  let files: string[] = []
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')) } catch { return [] }
  const out: CommandInfo[] = []
  for (const f of files) {
    try {
      const { data, body } = parseFrontmatter(await fsp.readFile(join(dir, f), 'utf8'))
      out.push({ name: f.replace(/\.md$/, ''), description: String(data.description ?? body.trim().split('\n')[0]?.slice(0, 100) ?? ''), template: body.trim(), agent: data.agent ? String(data.agent) : undefined, hint: data.hint ? String(data.hint) : undefined, source })
    } catch { /* skip */ }
  }
  return out
}

export async function listCommands(root: string | null): Promise<CommandInfo[]> {
  const byName = new Map<string, CommandInfo>()
  for (const c of BUILTIN_COMMANDS) byName.set(c.name, c)
  for (const c of await loadCommandDir(dataPath('commands'), 'global')) byName.set(c.name, c)
  if (home()) for (const c of await loadCommandDir(join(home(), '.claude', 'commands'), 'global')) byName.set(c.name, c)
  if (root) {
    for (const c of await loadCommandDir(join(root, '.claude', 'commands'), 'project')) byName.set(c.name, c)
    for (const c of await loadCommandDir(join(root, PROJECT_DIR, 'commands'), 'project')) byName.set(c.name, c)
  }
  return [...byName.values()]
}

export function expandCommand(template: string, args: string): string {
  const parts = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map(a => a.replace(/^["']|["']$/g, '')) ?? []
  let out = template.replace(/\$ARGUMENTS/g, args.trim())
  out = out.replace(/\$([1-9])/g, (_m, n: string) => parts[Number(n) - 1] ?? '')
  if (!/\$ARGUMENTS/.test(template) && args.trim() && !/\$[1-9]/.test(template)) out += `\n\n${args.trim()}`
  return out.trim()
}

// ───────────── Project instructions ─────────────
export interface InstructionFile { path: string; content: string }

const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', join(PROJECT_DIR, 'instructions.md'), join('.github', 'copilot-instructions.md')]

export function loadInstructions(root: string | null, maxChars = 24_000): InstructionFile[] {
  const out: InstructionFile[] = []
  const add = (p: string) => {
    try { if (existsSync(p)) out.push({ path: p, content: readFileSync(p, 'utf8').slice(0, maxChars) }) } catch { /* unreadable */ }
  }
  add(dataPath('AGENTS.md'))
  if (home()) add(join(home(), '.claude', 'CLAUDE.md'))
  if (root) {
    // AGENTS.md wins over CLAUDE.md if both exist (they usually duplicate each other)
    let first = true
    for (const n of INSTRUCTION_NAMES) {
      const p = resolve(root, n)
      if (!existsSync(p)) continue
      if (first || n === join(PROJECT_DIR, 'instructions.md')) { add(p); first = false } else if (!/CLAUDE\.md$|AGENTS\.md$/.test(n)) add(p)
    }
  }
  return out
}

// ───────────── Memory ─────────────
const globalMemoryPath = () => join(dataDir(), 'memory.md')
const projectMemoryPath = (root: string | null) => (root ? join(root, PROJECT_DIR, 'memory.md') : null)

export async function readMemory(root: string | null): Promise<MemoryState> {
  const pp = projectMemoryPath(root)
  const read = async (p: string | null) => { if (!p) return ''; try { return await fsp.readFile(p, 'utf8') } catch { return '' } }
  return { project: await read(pp), global: await read(globalMemoryPath()), projectPath: pp, globalPath: globalMemoryPath() }
}

export async function writeMemory(root: string | null, scope: 'project' | 'global', text: string): Promise<void> {
  const p = scope === 'global' ? globalMemoryPath() : projectMemoryPath(root)
  if (!p) throw new Error('Open a project folder to use project memory.')
  await fsp.mkdir(dirname(p), { recursive: true })
  await fsp.writeFile(p, text, 'utf8')
}
