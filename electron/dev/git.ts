import { promises as fsp, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GitApi, GitBlameLine, GitBranch, GitCommit, GitCommitDetail, GitConflictSides, GitDiffSides, GitFile, GitStash, GitStatus } from '../../shared/dev'
import { run, which, type RunResult } from '../services/proc'
import { workspace } from '../services/workspace'
import { uid } from '../services/storage'

const NET_TIMEOUT = 180_000

function baseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0' }
}

let gitPath: string | null | undefined
export function gitAvailable(): boolean {
  if (gitPath === undefined) gitPath = which('git')
  return !!gitPath
}

interface GitOpts { cwd?: string; input?: string; timeoutMs?: number; allowFail?: boolean; maxBuffer?: number; env?: NodeJS.ProcessEnv }

async function git(args: string[], o: GitOpts = {}): Promise<RunResult> {
  const cwd = o.cwd ?? workspace.requireRoot()
  const r = await run('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, input: o.input, timeoutMs: o.timeoutMs ?? 30_000, maxBuffer: o.maxBuffer ?? 4_000_000, env: o.env ?? baseEnv() })
  if (r.error && /ENOENT/.test(r.error)) throw new Error('Git is not installed (or not on PATH). Install Git from https://git-scm.com and restart the IDE.')
  if (r.timedOut) throw new Error(`git ${args[0]} timed out`)
  if (r.code !== 0 && !o.allowFail) throw new Error((r.stderr.trim() || r.stdout.trim() || `git ${args.join(' ')} failed (exit ${r.code})`).slice(0, 2000))
  return r
}

const text = async (args: string[], o: GitOpts = {}) => (await git(args, o)).stdout

async function repoRoot(): Promise<string | null> {
  const root = workspace.root
  if (!root || !gitAvailable()) return null
  const r = await git(['rev-parse', '--show-toplevel'], { allowFail: true, cwd: root })
  if (r.code !== 0) return null
  return r.stdout.trim().replace(/\//g, process.platform === 'win32' ? '\\' : '/')
}

async function hasHead(root: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true })).code === 0
}

async function showBlob(root: string, spec: string): Promise<string | null> {
  const r = await git(['show', spec], { cwd: root, allowFail: true, maxBuffer: 8_000_000 })
  return r.code === 0 ? r.stdout : null
}

const hasNul = (s: string) => s.includes('\0')

export function parseStatus(out: string): Omit<GitStatus, 'isRepo' | 'root' | 'merging' | 'rebasing' | 'cherryPicking' | 'stashCount'> {
  const parts = out.split('\0')
  const res = { branch: null as string | null, detached: false, upstream: null as string | null, ahead: 0, behind: 0, files: [] as GitFile[], head: null as string | null }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# ')) {
      const [, key, ...rest] = p.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') { res.detached = val === '(detached)'; res.branch = res.detached ? null : val }
      else if (key === 'branch.upstream') res.upstream = val
      else if (key === 'branch.oid') res.head = val === '(initial)' ? null : val.slice(0, 8)
      else if (key === 'branch.ab') { const m = val.match(/\+(\d+) -(\d+)/); if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]) } }
      continue
    }
    const kind = p[0]
    if (kind === '1') {
      const f = p.split(' ')
      const xy = f[1]
      res.files.push({ path: f.slice(8).join(' '), index: xy[0], worktree: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false, conflict: false })
    } else if (kind === '2') {
      const f = p.split(' ')
      const xy = f[1]
      const orig = parts[++i]
      res.files.push({ path: f.slice(9).join(' '), origPath: orig, index: xy[0], worktree: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false, conflict: false })
    } else if (kind === 'u') {
      const f = p.split(' ')
      res.files.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U', staged: false, unstaged: true, untracked: false, conflict: true })
    } else if (kind === '?') {
      res.files.push({ path: p.slice(2), index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflict: false })
    }
  }
  return res
}

function parseLog(out: string): GitCommit[] {
  return out.split('\x1e').map(r => r.replace(/^\n/, '')).filter(r => r.trim()).map(rec => {
    const [hash, short, author, email, ct, parents, refs, subject, body] = rec.split('\x1f')
    return {
      hash, short, author, email, date: Number(ct) * 1000, subject, body: (body ?? '').trim() || undefined,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: refs ? refs.split(', ').map(s => s.trim()).filter(Boolean) : []
    }
  })
}
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%P%x1f%D%x1f%s%x1f%b%x1e'

export const gitApi: GitApi = {
  async status() {
    const empty = (extra: Partial<GitStatus> = {}): GitStatus => ({ isRepo: false, root: workspace.root ?? '', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], merging: false, rebasing: false, cherryPicking: false, stashCount: 0, head: null, ...extra })
    if (!workspace.root) return empty()
    if (!gitAvailable()) return empty({ gitMissing: true })
    const root = await repoRoot()
    if (!root) return empty()
    const out = await text(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root })
    const base = parseStatus(out)
    const gd = join(root, '.git')
    const stash = await git(['rev-list', '--walk-reflogs', '--count', 'refs/stash'], { cwd: root, allowFail: true })
    return {
      isRepo: true, root, ...base,
      merging: existsSync(join(gd, 'MERGE_HEAD')), rebasing: existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply')), cherryPicking: existsSync(join(gd, 'CHERRY_PICK_HEAD')),
      stashCount: stash.code === 0 ? Number(stash.stdout.trim()) || 0 : 0
    }
  },

  async init() { await git(['init'], { cwd: workspace.requireRoot() }) },

  async clone(url, dest) {
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/|[A-Za-z]:\\|\/)/.test(url)) throw new Error('Enter a valid repository URL')
    await git(['clone', '--progress', url], { cwd: dest, timeoutMs: 600_000 })
    const name = url.replace(/\/+$/, '').split(/[/\\:]/).pop()!.replace(/\.git$/, '')
    return join(dest, name)
  },

  async diffSides(path, mode, commit): Promise<GitDiffSides> {
    const root = (await repoRoot())!
    const rel = path.replace(/\\/g, '/')
    let original: string | null = '', modified: string | null = ''
    let oLabel = '', mLabel = ''
    if (mode === 'staged') {
      original = (await hasHead(root)) ? await showBlob(root, `HEAD:${rel}`) : null
      modified = await showBlob(root, `:${rel}`)
      oLabel = 'HEAD'; mLabel = 'Staged'
    } else if (mode === 'unstaged') {
      original = await showBlob(root, `:${rel}`)
      try { modified = await fsp.readFile(join(root, rel), 'utf8') } catch { modified = null }
      oLabel = 'Index'; mLabel = 'Working tree'
    } else {
      original = await showBlob(root, `${commit}^:${rel}`)
      modified = await showBlob(root, `${commit}:${rel}`)
      oLabel = `${commit!.slice(0, 7)}^`; mLabel = commit!.slice(0, 7)
    }
    const binary = (original != null && hasNul(original)) || (modified != null && hasNul(modified))
    return { original: binary ? '' : original ?? '', modified: binary ? '' : modified ?? '', binary, originalLabel: oLabel, modifiedLabel: mLabel }
  },

  async diffText(mode, paths) {
    const root = (await repoRoot())!
    const args = ['diff', '--no-color']
    if (mode === 'staged') args.push('--cached'); else if (mode === 'all') args.push('HEAD')
    if (paths?.length) args.push('--', ...paths)
    const r = await git(args, { cwd: root, allowFail: true, maxBuffer: 800_000 })
    return r.stdout
  },

  async stage(paths) { if (paths.length) await git(['add', '-A', '--', ...paths], { cwd: (await repoRoot())! }) },
  async unstage(paths) {
    const root = (await repoRoot())!
    if (!paths.length) return
    if (await hasHead(root)) await git(['restore', '--staged', '--', ...paths], { cwd: root })
    else await git(['rm', '--cached', '-r', '-q', '--', ...paths], { cwd: root })
  },
  async stageAll() { await git(['add', '-A'], { cwd: (await repoRoot())! }) },
  async unstageAll() { const root = (await repoRoot())!; if (await hasHead(root)) await git(['reset', '-q'], { cwd: root }); else await git(['rm', '--cached', '-r', '-q', '.'], { cwd: root, allowFail: true }) },

  async discard(paths) {
    const root = (await repoRoot())!
    const st = parseStatus(await text(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: root }))
    for (const p of paths) {
      const f = st.files.find(x => x.path === p)
      if (!f) continue
      if (f.untracked) await git(['clean', '-fd', '--', p], { cwd: root })
      else if (f.index === 'A') await git(['rm', '-f', '-q', '--', p], { cwd: root })
      else {
        const r = await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', p], { cwd: root, allowFail: true })
        if (r.code !== 0) await git(['checkout', 'HEAD', '--', p], { cwd: root })
      }
    }
  },

  async applyPatch(patch, cached, reverse) {
    await git(['apply', ...(cached ? ['--cached'] : []), ...(reverse ? ['-R'] : []), '--whitespace=nowarn', '--recount', '-'], { cwd: (await repoRoot())!, input: patch })
  },

  async commit({ message, amend, signoff, stageAll }) {
    const root = (await repoRoot())!
    if (!message.trim() && !amend) throw new Error('Enter a commit message')
    if (stageAll) await git(['add', '-A'], { cwd: root })
    const args = ['commit', ...(amend ? ['--amend'] : []), ...(signoff ? ['-s'] : [])]
    if (message.trim()) args.push('-F', '-')
    else args.push('--no-edit')
    await git(args, { cwd: root, input: message, timeoutMs: 120_000 })
    return (await text(['rev-parse', '--short', 'HEAD'], { cwd: root })).trim()
  },

  async branches(): Promise<GitBranch[]> {
    const root = (await repoRoot())!
    const out = await text(['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)%00%(subject)%00%(committerdate:unix)%00%(upstream:track)', 'refs/heads', 'refs/remotes'], { cwd: root })
    return out.split('\n').filter(Boolean).map(line => {
      const [ref, short, hash, upstream, head, subject, date, track] = line.split('\0')
      const remote = ref.startsWith('refs/remotes/')
      const ahead = track?.match(/ahead (\d+)/), behind = track?.match(/behind (\d+)/)
      return { name: short, current: head === '*', remote, upstream: upstream || undefined, hash, subject, date: date ? new Date(Number(date) * 1000).toISOString() : undefined, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 }
    }).filter(b => !b.name.endsWith('/HEAD'))
  },

  async checkout(name, create, from) {
    const root = (await repoRoot())!
    if (create) await git(['checkout', '-b', name, ...(from ? [from] : [])], { cwd: root })
    else {
      const remote = (await git(['show-ref', '--verify', '-q', `refs/remotes/${name}`], { cwd: root, allowFail: true })).code === 0
      const local = (await git(['show-ref', '--verify', '-q', `refs/heads/${name}`], { cwd: root, allowFail: true })).code === 0
      if (remote && !local) await git(['checkout', '--track', name], { cwd: root })
      else await git(['checkout', name], { cwd: root })
    }
  },
  async deleteBranch(name, force) { await git(['branch', force ? '-D' : '-d', name], { cwd: (await repoRoot())! }) },
  async renameBranch(from, to) { await git(['branch', '-m', from, to], { cwd: (await repoRoot())! }) },

  async merge(branch, opts) {
    const r = await git(['merge', ...(opts?.noFf ? ['--no-ff'] : []), ...(opts?.squash ? ['--squash'] : []), branch], { cwd: (await repoRoot())!, allowFail: true, timeoutMs: 120_000 })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT|Automatic merge failed/.test(out)) throw new Error(out)
    return out
  },
  async mergeAbort() { await git(['merge', '--abort'], { cwd: (await repoRoot())! }) },
  async rebase(onto) {
    const r = await git(['rebase', onto], { cwd: (await repoRoot())!, allowFail: true, timeoutMs: 120_000 })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT|could not apply/i.test(out)) throw new Error(out)
    return out
  },
  async rebaseAction(action) {
    const r = await git(['rebase', `--${action}`], { cwd: (await repoRoot())!, allowFail: true, env: { ...baseEnv(), GIT_EDITOR: 'true' } })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT|could not apply/i.test(out)) throw new Error(out)
    return out
  },
  async cherryPick(hash) {
    const r = await git(['cherry-pick', hash], { cwd: (await repoRoot())!, allowFail: true })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT/.test(out)) throw new Error(out)
    return out
  },
  async revert(hash) {
    const r = await git(['revert', '--no-edit', hash], { cwd: (await repoRoot())!, allowFail: true })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT/.test(out)) throw new Error(out)
    return out
  },

  async stashList(): Promise<GitStash[]> {
    const out = await text(['stash', 'list', '--format=%gd%x00%gs%x00%ct'], { cwd: (await repoRoot())! })
    return out.split('\n').filter(Boolean).map((l, i) => {
      const [, msg, ct] = l.split('\0')
      const m = msg.match(/^(?:WIP on|On) ([^:]+): ?(.*)$/)
      return { index: i, message: m ? (m[2] || msg) : msg, branch: m ? m[1] : '', date: Number(ct) * 1000 }
    })
  },
  async stashPush(message, includeUntracked) { return (await text(['stash', 'push', ...(includeUntracked ? ['-u'] : []), ...(message ? ['-m', message] : [])], { cwd: (await repoRoot())! })).trim() },
  async stashApply(index, pop) {
    const r = await git(['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { cwd: (await repoRoot())!, allowFail: true })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT/.test(out)) throw new Error(out)
    return out
  },
  async stashDrop(index) { await git(['stash', 'drop', `stash@{${index}}`], { cwd: (await repoRoot())! }) },
  async stashShow(index) { return text(['stash', 'show', '-p', '--no-color', `stash@{${index}}`], { cwd: (await repoRoot())!, maxBuffer: 800_000 }) },

  async remotes() {
    const out = await text(['remote', '-v'], { cwd: (await repoRoot())! })
    const seen = new Map<string, string>()
    for (const l of out.split('\n')) { const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/); if (m) seen.set(m[1], m[2]) }
    return [...seen].map(([name, url]) => ({ name, url }))
  },
  async addRemote(name, url) { await git(['remote', 'add', name, url], { cwd: (await repoRoot())! }) },
  async fetch(remote) { const r = await git(['fetch', '--prune', ...(remote ? [remote] : ['--all'])], { cwd: (await repoRoot())!, timeoutMs: NET_TIMEOUT }); return (r.stdout + r.stderr).trim() },
  async pull(o) {
    const r = await git(['pull', ...(o?.rebase ? ['--rebase'] : ['--no-rebase'])], { cwd: (await repoRoot())!, timeoutMs: NET_TIMEOUT, allowFail: true })
    const out = (r.stdout + r.stderr).trim()
    if (r.code !== 0 && !/CONFLICT/.test(out)) throw new Error(out)
    return out
  },
  async push(o) {
    const args = ['push']
    if (o?.setUpstream) args.push('-u')
    if (o?.forceWithLease) args.push('--force-with-lease')
    if (o?.tags) args.push('--tags')
    if (o?.remote) args.push(o.remote)
    if (o?.branch) args.push(o.branch)
    const r = await git(args, { cwd: (await repoRoot())!, timeoutMs: NET_TIMEOUT })
    return (r.stdout + r.stderr).trim()
  },

  async log(o) {
    const root = (await repoRoot())!
    if (!(await hasHead(root))) return []
    const args = ['log', `--format=${LOG_FORMAT}`, `-n${o?.limit ?? 100}`, '--date-order']
    if (o?.skip) args.push(`--skip=${o.skip}`)
    if (o?.all) args.push('--all')
    if (o?.search) args.push(`--grep=${o.search}`, '-i')
    if (o?.branch) args.push(o.branch)
    if (o?.path) args.push('--', o.path)
    return parseLog(await text(args, { cwd: root, maxBuffer: 8_000_000 }))
  },

  async show(hash): Promise<GitCommitDetail> {
    const root = (await repoRoot())!
    const meta = parseLog(await text(['show', '-s', `--format=${LOG_FORMAT}`, hash], { cwd: root }))[0]
    const status = (await text(['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '--root', hash], { cwd: root })).split('\n').filter(Boolean)
    const nums = (await text(['diff-tree', '--no-commit-id', '--numstat', '-r', '-M', '--root', hash], { cwd: root })).split('\n').filter(Boolean)
    const files = status.map((l, i) => {
      const [st, a, b] = l.split('\t')
      const [added, removed] = (nums[i] ?? '0\t0').split('\t')
      return { status: st[0], path: b ?? a, oldPath: b ? a : undefined, added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed) }
    })
    return { ...meta, files }
  },

  async conflictSides(path): Promise<GitConflictSides> {
    const root = (await repoRoot())!
    const rel = path.replace(/\\/g, '/')
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map(async n => (await showBlob(root, `:${n}:${rel}`)) ?? ''))
    let merged = ''
    try { merged = await fsp.readFile(join(root, rel), 'utf8') } catch { /* deleted */ }
    return { base, ours, theirs, merged }
  },

  async resolveConflict(path, resolution, content) {
    const root = (await repoRoot())!
    const rel = path.replace(/\\/g, '/')
    const file = join(root, rel)
    if (resolution === 'ours' || resolution === 'theirs') {
      await git(['checkout', `--${resolution}`, '--', rel], { cwd: root })
    } else if (resolution === 'merged') {
      await fsp.writeFile(file, content ?? '', 'utf8')
    } else {
      const sides = await gitApi.conflictSides(path)
      const dir = join(tmpdir(), uid('merge-'))
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(join(dir, 'ours'), sides.ours); await fsp.writeFile(join(dir, 'base'), sides.base); await fsp.writeFile(join(dir, 'theirs'), sides.theirs)
      const r = await git(['merge-file', '-p', '--union', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { cwd: root, allowFail: true })
      await fsp.rm(dir, { recursive: true, force: true })
      await fsp.writeFile(file, r.stdout, 'utf8')
    }
    await git(['add', '--', rel], { cwd: root })
  },

  async blame(path): Promise<GitBlameLine[]> {
    const root = (await repoRoot())!
    const r = await git(['blame', '--line-porcelain', '--', path.replace(/\\/g, '/')], { cwd: root, allowFail: true, maxBuffer: 6_000_000 })
    if (r.code !== 0) return []
    const out: GitBlameLine[] = []
    let cur: Partial<GitBlameLine> = {}
    for (const l of r.stdout.split('\n')) {
      const h = l.match(/^([0-9a-f]{40}) \d+ (\d+)/)
      if (h) { cur = { hash: h[1].slice(0, 8), line: Number(h[2]) }; continue }
      if (l.startsWith('author ')) cur.author = l.slice(7)
      else if (l.startsWith('author-time ')) cur.date = Number(l.slice(12)) * 1000
      else if (l.startsWith('summary ')) cur.summary = l.slice(8)
      else if (l.startsWith('\t')) out.push({ line: cur.line!, hash: cur.hash!, author: cur.author ?? '', date: cur.date ?? 0, summary: cur.summary ?? '' })
    }
    return out
  },

  async identity() {
    const root = (await repoRoot()) ?? workspace.root!
    const n = await git(['config', 'user.name'], { cwd: root, allowFail: true })
    const e = await git(['config', 'user.email'], { cwd: root, allowFail: true })
    return { name: n.stdout.trim(), email: e.stdout.trim() }
  },
  async setIdentity(name, email) {
    const root = (await repoRoot()) ?? workspace.requireRoot()
    await git(['config', 'user.name', name], { cwd: root }); await git(['config', 'user.email', email], { cwd: root })
  },
  async ignore(pattern) {
    const root = (await repoRoot())!
    const f = join(root, '.gitignore')
    let cur = ''
    try { cur = await fsp.readFile(f, 'utf8') } catch { /* new file */ }
    if (!cur.split(/\r?\n/).includes(pattern)) await fsp.writeFile(f, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + pattern + '\n')
  },
  async createTag(name, message) { await git(['tag', ...(message ? ['-a', name, '-m', message] : [name])], { cwd: (await repoRoot())! }) }
}
