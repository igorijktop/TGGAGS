import { z } from 'zod'
import { defineTool, ToolError, type ToolDef } from '../types'
import type { Todo } from '../../../../shared/ai'
import { uid } from '../../../services/storage'

const todoItem = z.object({
  id: z.string().optional().describe('Stable id (optional)'),
  content: z.string().min(1).describe('Brief imperative description of the task'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']).optional()
})

function summarizeTodos(todos: Todo[]): string {
  if (!todos.length) return 'The todo list is empty.'
  const done = todos.filter(t => t.status === 'completed').length
  return `${done}/${todos.length} done\n` + todos.map(t => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`).join('\n')
}

export const todowriteTool = defineTool({
  name: 'todowrite',
  category: 'todo',
  description: `Create and update the task list for the current session. Use it proactively for any task with 3 or more steps: write the plan first, keep exactly one item in_progress, and mark items completed immediately after finishing them. Always send the complete list (it replaces the previous one).`,
  schema: z.object({ todos: z.array(todoItem).describe('The full, updated todo list') }),
  describe: i => ({ title: `Updating todos (${i.todos.length})`, checks: [{ category: 'todo', resources: ['todo'], title: 'Update todo list' }] }),
  async execute(i, ctx) {
    const todos: Todo[] = i.todos.map(t => ({ id: t.id ?? uid('t'), content: t.content, status: t.status, priority: t.priority }))
    ctx.runtime.setTodos(todos)
    return { output: summarizeTodos(todos), title: `Todos ${todos.filter(t => t.status === 'completed').length}/${todos.length}` }
  }
})

export const todoreadTool = defineTool({
  name: 'todoread',
  category: 'todo',
  readOnly: true,
  description: 'Read the current todo list for this session.',
  schema: z.object({}),
  describe: () => ({ title: 'Reading todos', checks: [{ category: 'todo', resources: ['todo'], title: 'Read todo list' }] }),
  async execute(_i, ctx) { return { output: summarizeTodos(ctx.runtime.session.todos) } }
})

export const questionTool = defineTool({
  name: 'question',
  category: 'question',
  description: `Ask the user one or more structured questions and wait for the answers. Use this ONLY when you genuinely cannot proceed without a decision that only the user can make (ambiguous requirements, a choice between approaches with real trade-offs, missing credentials). Do not ask for confirmation of things you can verify yourself. Offer concrete options when possible.`,
  schema: z.object({
    questions: z.array(z.object({
      question: z.string().describe('The full question'),
      header: z.string().max(30).optional().describe('Very short label'),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional().describe('Suggested answers'),
      multiple: z.boolean().optional().describe('Allow selecting several options'),
      allowCustom: z.boolean().optional().describe('Allow a free-text answer (default true)')
    })).min(1).max(4)
  }),
  describe: i => ({ title: `Asking: ${i.questions[0].header ?? i.questions[0].question.slice(0, 40)}`, checks: [{ category: 'question', resources: ['question'], title: 'Ask the user' }] }),
  async execute(i, ctx) {
    const qs = i.questions.map((q, n) => ({ id: `q${n + 1}`, ...q }))
    const answers = await ctx.runtime.ask(qs)
    if (!answers) return { output: 'The user dismissed the question without answering. Continue with your best judgement or explain what you need.', title: 'Question dismissed' }
    return { output: qs.map(q => `Q: ${q.question}\nA: ${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join(', ') : answers[q.id] ?? '(no answer)'}`).join('\n\n'), title: 'Answered' }
  }
})

export function makeSkillTool(listSkills: () => { name: string; description: string }[]): ToolDef {
  const skills = listSkills()
  const list = skills.length ? skills.map(s => `- ${s.name}: ${s.description}`).join('\n') : '(no skills installed)'
  return defineTool({
    name: 'skill',
    category: 'skill',
    readOnly: true,
    description: `Load a skill – a reusable set of instructions for a specialised task. Call it when the task matches a skill's description, then follow the returned instructions.\nAvailable skills:\n${list}`,
    schema: z.object({ name: z.string().describe('Skill name') }),
    describe: i => ({ title: `Loading skill ${i.name}`, checks: [{ category: 'skill', resources: [i.name], title: `Load skill ${i.name}` }] }),
    async execute(i, ctx) {
      const s = await ctx.runtime.loadSkill(i.name)
      if (!s) throw new ToolError(`Skill "${i.name}" not found. Available: ${ctx.runtime.listSkills().map(x => x.name).join(', ') || 'none'}`)
      return { output: `<skill name="${s.name}" dir="${s.dir}">\n${s.content}\n</skill>${s.files.length ? `\n\nBundled files (relative to ${s.dir}):\n${s.files.join('\n')}` : ''}`, title: `Loaded ${s.name}` }
    }
  })
}

export function makeSubagentTool(agents: () => { id: string; name: string; description: string }[]): ToolDef {
  const list = agents().map(a => `- ${a.id}: ${a.description}`).join('\n')
  return defineTool({
    name: 'subagent',
    category: 'subagent',
    timeoutMs: 3_600_000,
    description: `Delegate a self-contained task to a specialised sub-agent that works independently and returns a single report. Use it to explore a large codebase, research, review code or investigate failures without filling your own context. Launch several in one message to work in parallel. The sub-agent cannot see this conversation, so give it a complete, specific prompt and say exactly what to return.
Available agents:
${list}`,
    schema: z.object({
      agent: z.string().describe('Agent id, e.g. "explore"'),
      description: z.string().describe('Short (3-6 words) task label'),
      prompt: z.string().min(10).describe('Complete instructions for the sub-agent')
    }),
    describe: i => ({ title: `Delegating: ${i.description}`, checks: [{ category: 'subagent', resources: [i.agent], title: `Run sub-agent ${i.agent}: ${i.description}` }] }),
    async execute(i, ctx) {
      const r = await ctx.runtime.runSubagent({ agent: i.agent, prompt: i.prompt, description: i.description, signal: ctx.signal, parentToolCallId: ctx.toolCallId })
      return { output: r.text || '(the sub-agent returned no text)', title: i.description, meta: { childSessionId: r.sessionId, steps: r.steps } }
    }
  })
}

export const memoryTool = defineTool({
  name: 'memory',
  category: 'memory',
  description: `Read or update persistent memory that survives across sessions. "project" memory lives in .tgg/memory.md of this project; "global" memory applies everywhere. Save durable facts the user would want remembered: conventions, commands, preferences, decisions. Keep entries short; do not store secrets.`,
  schema: z.object({
    action: z.enum(['read', 'append', 'replace']),
    scope: z.enum(['project', 'global']).optional().describe('Default: project'),
    text: z.string().optional().describe('Text to append, or the full new content for replace')
  }),
  describe: i => ({ title: `Memory ${i.action}`, checks: [{ category: 'memory', resources: [i.scope ?? 'project'], title: `Memory ${i.action} (${i.scope ?? 'project'})` }] }),
  async execute(i, ctx) {
    const scope = i.scope ?? 'project'
    const cur = await ctx.runtime.memory.read(scope)
    if (i.action === 'read') return { output: cur.trim() || '(memory is empty)' }
    if (!i.text?.trim()) throw new ToolError('text is required for append/replace.')
    if (i.action === 'append') await ctx.runtime.memory.write(scope, (cur.trimEnd() ? cur.trimEnd() + '\n' : '') + (i.text.startsWith('-') ? i.text : `- ${i.text}`).trim() + '\n')
    else await ctx.runtime.memory.write(scope, i.text)
    return { output: `Memory (${scope}) updated.`, title: 'Memory updated' }
  }
})
