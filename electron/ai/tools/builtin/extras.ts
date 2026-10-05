import { z } from 'zod'
import { promises as fsp } from 'node:fs'
import { defineTool, ToolError } from '../types'
import { resolvePath, displayPath } from '../util'
import { generateImages, assets } from '../../../media/images'
import { githubApi } from '../../../integrations/github'
import { settings } from '../../../services/settings'
import { refKey } from '../../../../shared/settings'
import { dirname } from 'node:path'

export const imageTool = defineTool({
  name: 'generate_image',
  category: 'image',
  timeoutMs: 300_000,
  description: 'Generate an image from a text prompt with the configured image model (e.g. GPT Image, Gemini, Stable Diffusion). The image is stored in the Asset Library; pass savePath to also copy it into the project (e.g. "public/hero.png"). Use for logos, icons, illustrations, UI mockups and placeholder art.',
  schema: z.object({
    prompt: z.string().min(3).describe('Detailed description of the image'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512']).optional(),
    savePath: z.string().optional().describe('Optional project path to save a copy to'),
    n: z.number().int().min(1).max(4).optional()
  }),
  describe(i, ctx) {
    const model = settings.get().images.defaultModel
    const checks: import('../types').PermissionCheck[] = [{ category: 'image', resources: [model ? refKey(model) : 'default'], title: `Generate image: ${i.prompt.slice(0, 80)}`, detail: model ? `${model.provider} / ${model.model}` : 'No image model selected' }]
    if (i.savePath) checks.push({ isPath: true, category: 'edit', resources: [resolvePath(ctx.root, ctx.cwd, i.savePath)], title: `Save image to ${i.savePath}` })
    return { title: 'Generating image', checks }
  },
  async execute(i, ctx) {
    const model = settings.get().images.defaultModel
    if (!model) throw new ToolError('No image model is selected. Open the Images view and choose a model first (Settings → Models to add a provider).')
    const made = await generateImages({ mode: 'generate', model, prompt: i.prompt, size: i.size ?? '1024x1024', n: i.n ?? 1 }, ctx.signal)
    const lines = made.map(a => `Created image "${a.name}" (${a.width ?? '?'}×${a.height ?? '?'}) – asset ${a.id}`)
    if (i.savePath) {
      const dest = resolvePath(ctx.root, ctx.cwd, i.savePath)
      await fsp.mkdir(dirname(dest), { recursive: true })
      await fsp.copyFile(assets.pathOf(made[0]), dest)
      ctx.runtime.markRead(dest, (await fsp.stat(dest)).mtimeMs)
      lines.push(`Saved to ${displayPath(ctx.root, dest)}`)
    }
    const first = await assets.read(made[0])
    return { output: lines.join('\n'), title: `Generated ${made.length} image${made.length === 1 ? '' : 's'}`, images: [{ mime: first.mime, data: first.data }] }
  }
})

export const githubTool = defineTool({
  name: 'github',
  category: 'external_api',
  timeoutMs: 60_000,
  description: 'Work with the GitHub repository of this project (needs a token in the GitHub panel). Actions: list_prs, get_pr, list_issues, get_issue, create_issue, comment, create_pr, list_runs.',
  schema: z.object({
    action: z.enum(['list_prs', 'get_pr', 'list_issues', 'get_issue', 'create_issue', 'comment', 'create_pr', 'list_runs']),
    number: z.number().int().optional(), state: z.enum(['open', 'closed', 'all']).optional(),
    title: z.string().optional(), body: z.string().optional(), head: z.string().optional(), base: z.string().optional(), draft: z.boolean().optional()
  }),
  describe(i) {
    const write = ['create_issue', 'comment', 'create_pr'].includes(i.action)
    return { title: `GitHub: ${i.action}`, checks: [{ category: 'external_api', toolName: write ? 'github:write' : 'github:read', resources: [`github.com`], title: `GitHub ${i.action.replace('_', ' ')}`, detail: JSON.stringify({ ...i, body: i.body?.slice(0, 200) }), requireAsk: write }] }
  },
  async execute(i) {
    const fmtDate = (s: string) => s.slice(0, 10)
    switch (i.action) {
      case 'list_prs': return { output: (await githubApi.pulls(i.state ?? 'open')).map(p => `#${p.number} [${p.state}] ${p.title} (${p.head} → ${p.base}) by ${p.author}, ${fmtDate(p.updated)}`).join('\n') || 'No pull requests.' }
      case 'get_pr': { if (!i.number) throw new ToolError('number required'); const r = await githubApi.pull(i.number); return { output: `#${r.pull.number} ${r.pull.title} [${r.pull.state}]\n${r.pull.body ?? ''}\n\nFiles:\n${r.files.map(f => `${f.status} ${f.path} (+${f.additions} -${f.deletions})`).join('\n')}\n\nChecks:\n${r.checks.map(c => `${c.name}: ${c.conclusion ?? c.status}`).join('\n') || 'none'}\n\nComments:\n${r.comments.map(c => `${c.author}: ${c.body.slice(0, 400)}`).join('\n---\n') || 'none'}` } }
      case 'list_issues': return { output: (await githubApi.issues(i.state ?? 'open')).map(x => `#${x.number} [${x.state}] ${x.title} ${x.labels.map(l => `{${l.name}}`).join('')} by ${x.author}`).join('\n') || 'No issues.' }
      case 'get_issue': { if (!i.number) throw new ToolError('number required'); const r = await githubApi.issue(i.number); return { output: `#${r.issue.number} ${r.issue.title} [${r.issue.state}]\n${r.issue.body ?? ''}\n\nComments:\n${r.comments.map(c => `${c.author}: ${c.body.slice(0, 500)}`).join('\n---\n') || 'none'}` } }
      case 'create_issue': { if (!i.title) throw new ToolError('title required'); const x = await githubApi.createIssue(i.title, i.body ?? ''); return { output: `Created issue #${x.number}: ${x.url}` } }
      case 'comment': { if (!i.number || !i.body) throw new ToolError('number and body required'); await githubApi.comment(i.number, i.body); return { output: 'Comment posted.' } }
      case 'create_pr': { if (!i.title || !i.head) throw new ToolError('title and head required'); const base = i.base ?? await githubApi.defaultBranch(); const p = await githubApi.createPull({ title: i.title, body: i.body ?? '', head: i.head, base, draft: i.draft }); return { output: `Created PR #${p.number}: ${p.url}` } }
      case 'list_runs': return { output: (await githubApi.runs()).map(r => `${r.name} [${r.conclusion ?? r.status}] ${r.branch} ${r.sha} ${fmtDate(r.created)}`).join('\n') || 'No workflow runs.' }
    }
  }
})
