import type { GhCheck, GhComment, GhIssue, GhPull, GhRepoRef, GhRun, GhUser, GithubApi } from '../../shared/media'
import { credentials } from '../services/credentials'
import { workspace } from '../services/workspace'
import { run } from '../services/proc'
import { httpFetch } from '../ai/providers/http'

const API = 'https://api.github.com'
const KEY = 'github:token'

async function gh<T>(path: string, init: { method?: string; body?: unknown } = {}, token = credentials.get(KEY)): Promise<T> {
  if (!token) throw new Error('Not signed in to GitHub. Add a personal access token in the GitHub panel.')
  const res = await httpFetch(path.startsWith('http') ? path : API + path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'TGGAGS-IDE', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined
  })
  if (!res.ok) {
    let msg = res.statusText
    try { const j = await res.json() as { message?: string; errors?: { message?: string }[] }; msg = [j.message, ...(j.errors ?? []).map(e => e.message)].filter(Boolean).join(': ') } catch { /* ignore */ }
    throw new Error(`GitHub ${res.status}: ${msg}${res.status === 401 ? ' (the token is invalid or expired)' : res.status === 403 ? ' (check the token scopes or rate limit)' : ''}`)
  }
  if (res.status === 204) return undefined as T
  return await res.json() as T
}

const user = (u: { login: string; name?: string; avatar_url: string; html_url: string }): GhUser => ({ login: u.login, name: u.name, avatar: u.avatar_url, url: u.html_url })

async function repoRef(): Promise<GhRepoRef | null> {
  const root = workspace.root
  if (!root) return null
  const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 5000 })
  if (r.code !== 0) return null
  const m = r.stdout.trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

async function needRepo(): Promise<GhRepoRef> {
  const r = await repoRef()
  if (!r) throw new Error('This project has no GitHub remote named "origin".')
  return r
}

const pull = (p: any): GhPull => ({
  number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: !!p.draft, author: p.user?.login ?? '', head: p.head?.ref ?? '', base: p.base?.ref ?? '', url: p.html_url, updated: p.updated_at,
  comments: (p.comments ?? 0) + (p.review_comments ?? 0), merged: !!p.merged_at || !!p.merged, body: p.body ?? '', mergeable: p.mergeable, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files
})
const issue = (i: any): GhIssue => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login ?? '', labels: (i.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })), url: i.html_url, updated: i.updated_at, comments: i.comments ?? 0, body: i.body ?? '' })
const comment = (c: any): GhComment => ({ author: c.user?.login ?? '', body: c.body ?? '', created: c.created_at, url: c.html_url })

export const githubApi: GithubApi = {
  async status() {
    const token = credentials.get(KEY)
    const repo = await repoRef().catch(() => null)
    if (!token) return { authenticated: false, repo }
    try { return { authenticated: true, user: user(await gh('/user')), repo } } catch (e) { return { authenticated: false, repo, error: (e as Error).message } }
  },
  async setToken(token) {
    try { const u = user(await gh('/user', {}, token.trim())); credentials.set(KEY, token.trim()); return { ok: true, user: u } } catch (e) { return { ok: false, error: (e as Error).message } }
  },
  async logout() { credentials.delete(KEY) },
  async repos() {
    const list = await gh<any[]>('/user/repos?per_page=60&sort=updated&affiliation=owner,collaborator,organization_member')
    return list.map(r => ({ full: r.full_name, description: r.description ?? '', private: r.private, url: r.html_url, cloneUrl: r.clone_url, updated: r.updated_at, stars: r.stargazers_count }))
  },
  async pulls(state) { const { owner, repo } = await needRepo(); return (await gh<any[]>(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=40&sort=updated&direction=desc`)).map(pull) },
  async pull(number) {
    const { owner, repo } = await needRepo()
    const p = await gh<any>(`/repos/${owner}/${repo}/pulls/${number}`)
    const [files, issueComments, reviewComments] = await Promise.all([
      gh<any[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=60`),
      gh<any[]>(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=40`),
      gh<any[]>(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=40`).catch(() => [])
    ])
    let checks: GhCheck[] = []
    try { checks = ((await gh<{ check_runs: any[] }>(`/repos/${owner}/${repo}/commits/${p.head.sha}/check-runs?per_page=30`)).check_runs ?? []).map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })) } catch { /* no checks */ }
    return {
      pull: pull(p), files: files.map(f => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
      comments: [...issueComments, ...reviewComments].map(comment).sort((a, b) => a.created.localeCompare(b.created)), checks
    }
  },
  async createPull(o) { const { owner, repo } = await needRepo(); return pull(await gh<any>(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { title: o.title, body: o.body, head: o.head, base: o.base, draft: !!o.draft } })) },
  async mergePull(number, method) { const { owner, repo } = await needRepo(); await gh(`/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } }) },
  async issues(state) { const { owner, repo } = await needRepo(); return (await gh<any[]>(`/repos/${owner}/${repo}/issues?state=${state}&per_page=40&sort=updated`)).filter(i => !i.pull_request).map(issue) },
  async issue(number) {
    const { owner, repo } = await needRepo()
    const [i, c] = await Promise.all([gh<any>(`/repos/${owner}/${repo}/issues/${number}`), gh<any[]>(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=40`)])
    return { issue: issue(i), comments: c.map(comment) }
  },
  async createIssue(title, body, labels) { const { owner, repo } = await needRepo(); return issue(await gh<any>(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body, labels } })) },
  async comment(number, body) { const { owner, repo } = await needRepo(); await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }) },
  async runs() {
    const { owner, repo } = await needRepo()
    const j = await gh<{ workflow_runs: any[] }>(`/repos/${owner}/${repo}/actions/runs?per_page=20`)
    return j.workflow_runs.map((r): GhRun => ({ id: r.id, name: r.name ?? r.display_title, status: r.status, conclusion: r.conclusion, branch: r.head_branch, event: r.event, url: r.html_url, created: r.created_at, sha: String(r.head_sha).slice(0, 7) }))
  },
  async defaultBranch() { const { owner, repo } = await needRepo(); return (await gh<{ default_branch: string }>(`/repos/${owner}/${repo}`)).default_branch }
}
