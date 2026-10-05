import { z } from 'zod'
import { spawn } from 'node:child_process'
import { defineTool, ToolError, type PermissionCheck } from '../types'
import { displayPath, insideRoot, resolvePath, truncateOutput } from '../util'
import { parseCommand, gitSubcommand } from '../shellparse'
import { killTree, defaultShell } from '../../../services/proc'
import { startBackground, readBackground, killBackground } from '../background'

export function shellEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TGG_AGENT: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }
}

export function commandChecks(command: string, cwd: string, root: string, title: string): PermissionCheck[] {
  const { segments, risky } = parseCommand(command)
  const checks: PermissionCheck[] = []
  const shellSegs: string[] = []
  const gitSegs: string[] = []
  for (const s of segments) {
    const g = gitSubcommand(s)
    shellSegs.push(s)
    if (g) gitSegs.push(g.rest || 'git')
  }
  checks.push({ category: 'shell', resources: shellSegs.length ? shellSegs : [command], title, detail: command, requireAsk: risky, preview: { kind: 'command', command, cwd } })
  if (gitSegs.length) checks.push({ category: 'git', resources: gitSegs, title: 'Git: ' + gitSegs.join(' ; '), detail: command })
  if (!insideRoot(root, cwd)) checks.push({ category: 'external_dir', isPath: true, resources: [cwd], title: `Run in ${cwd}` })
  return checks
}

export const shellTool = defineTool({
  name: 'shell',
  category: 'shell',
  timeoutMs: 600_000,
  description: `Run a shell command in the project (the user's default shell; see the environment section for which one) and return its output and exit code.
- Provide a short description of what the command does.
- Commands run non-interactively with no stdin; never run commands that wait for input.
- Default timeout 120 s (max 600 s). For long-running servers or watchers set background=true, then use shell_output / shell_kill.
- Prefer dedicated tools over shell for reading, searching and editing files (read, grep, glob, edit).
- Quote paths that contain spaces.`,
  schema: z.object({
    command: z.string().min(1).describe('The command line to run'),
    description: z.string().optional().describe('Short (5-10 words) description of what the command does'),
    cwd: z.string().optional().describe('Working directory (default: project root)'),
    timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Timeout in milliseconds (default 120000)'),
    background: z.boolean().optional().describe('Start the command in the background and return immediately')
  }),
  describe(i, ctx) {
    const cwd = i.cwd ? resolvePath(ctx.root, ctx.cwd, i.cwd) : ctx.cwd
    const shortCmd = i.command.length > 70 ? i.command.slice(0, 70) + '…' : i.command
    return { title: i.description?.trim() || `Running ${shortCmd}`, checks: commandChecks(i.command, cwd, ctx.root, i.description?.trim() || `Run ${shortCmd}`), plan: { cwd } }
  },
  async execute(i, ctx, plan) {
    const cwd = (plan as { cwd: string }).cwd
    const sh = defaultShell(ctx.settings.terminal.shell)
    const args = sh.args(i.command)
    if (i.background) {
      const bg = startBackground({ path: sh.path, args }, i.command, cwd, shellEnv())
      await new Promise(r => setTimeout(r, 1500))
      const r = readBackground(bg.id, true)!
      const t = await truncateOutput(r.text, { maxChars: 8000, save: false })
      return { output: `Started background process ${bg.id} (${r.running ? 'running' : `exited with ${r.exit}`}) in ${displayPath(ctx.root, cwd) || '.'}.\n${t.text ? 'Initial output:\n' + t.text : '(no output yet)'}\nUse shell_output with id "${bg.id}" to read more output and shell_kill to stop it.`, title: `Started ${bg.id}`, meta: { exitCode: null } }
    }
    const timeout = i.timeoutMs ?? 120_000
    return await new Promise(resolve => {
      const child = spawn(sh.path, args, { cwd, env: shellEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      let out = ''
      let timedOut = false, aborted = false
      let last = 0
      const MAX_RAM = 2_000_000
      const add = (d: Buffer) => {
        out += d.toString()
        if (out.length > MAX_RAM) out = out.slice(0, 500_000) + '\n… [middle of output dropped] …\n' + out.slice(out.length - 1_000_000)
        const now = Date.now()
        if (now - last > 120) { last = now; ctx.runtime.progress({ output: out.length > 20000 ? '…' + out.slice(-20000) : out }) }
      }
      child.stdout?.on('data', add); child.stderr?.on('data', add)
      const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeout)
      const onAbort = () => { aborted = true; killTree(child) }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) onAbort()
      const finish = async (code: number | null, err?: string) => {
        clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort)
        let text = out.replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        const t = await truncateOutput(text, { maxChars: 30_000, maxLines: 1500 })
        text = t.text
        const head = err ? `[failed to start: ${err}]\n` : ''
        const status = timedOut ? `\n[timed out after ${timeout / 1000}s – the process was killed]` : aborted ? '\n[cancelled by user]' : code !== 0 && code !== null ? `\n[exit code ${code}]` : ''
        const isErr = !!err || timedOut || aborted || (code !== 0 && code !== null)
        resolve({ output: `${head}${text || (isErr ? '' : '(no output)')}${status}`.trim(), title: i.description?.trim() || undefined, isError: isErr, meta: { exitCode: code, truncated: t.truncated } })
      }
      child.on('error', e => void finish(null, e.message))
      child.on('close', code => void finish(code))
    })
  }
})

export const shellOutputTool = defineTool({
  name: 'shell_output',
  category: 'shell',
  readOnly: true,
  description: 'Read new output from a background process started with shell (background=true).',
  schema: z.object({ id: z.string().describe('Background process id, e.g. bg_1'), all: z.boolean().optional().describe('Return the full buffered output instead of only new output') }),
  describe: i => ({ title: `Reading ${i.id}`, checks: [{ category: 'shell', toolName: 'shell_output', resources: [`shell_output ${i.id}`], title: `Read output of ${i.id}` }] }),
  async execute(i) {
    const r = readBackground(i.id, i.all)
    if (!r) throw new ToolError(`No background process "${i.id}".`)
    const t = await truncateOutput(r.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), { maxChars: 20_000, save: false })
    return { output: `${r.running ? '[running]' : `[exited with ${r.exit}]`} ${r.command}\n${t.text || '(no new output)'}` }
  }
})

export const shellKillTool = defineTool({
  name: 'shell_kill',
  category: 'shell',
  description: 'Stop a background process started with shell (background=true).',
  schema: z.object({ id: z.string() }),
  describe: i => ({ title: `Stopping ${i.id}`, checks: [{ category: 'shell', toolName: 'shell_kill', resources: [`shell_kill ${i.id}`], title: `Stop ${i.id}` }] }),
  async execute(i) {
    if (!killBackground(i.id)) throw new ToolError(`No background process "${i.id}".`)
    return { output: `Stopped ${i.id}.` }
  }
})
