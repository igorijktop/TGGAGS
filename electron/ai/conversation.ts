import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Message, Session, ToolPart } from '../../shared/ai'
import type { AgentConfig, Settings } from '../../shared/settings'
import type { ChatMessage, ReasoningBlock, ToolSpec } from './providers/types'
import { BASE_PROMPT } from './prompts'
import { defaultShell } from '../services/proc'
import { estimateTokens, IMAGE_TOKENS } from './context'
import type { InstructionFile } from './knowledge'

const INTERRUPTED = '[This tool call was interrupted before it finished. Its result is unknown – check the current state before relying on it.]'

function toolPartResult(p: ToolPart): { content: string; isError: boolean } {
  if (p.state === 'completed') return { content: p.output ?? '', isError: false }
  if (p.state === 'error' || p.state === 'denied') return { content: p.output ?? 'Error', isError: true }
  return { content: INTERRUPTED, isError: true }
}

/** Provider-neutral conversation for the model. Respects the latest compaction summary. */
export function toChatMessages(session: Session): ChatMessage[] {
  let start = 0
  for (let i = session.messages.length - 1; i >= 0; i--) if (session.messages[i].summary) { start = i; break }
  const out: ChatMessage[] = []
  for (const m of session.messages.slice(start)) {
    if (m.notice) continue
    if (m.role === 'user') {
      const parts: ({ type: 'text'; text: string } | { type: 'image'; mime: string; data: string })[] = []
      if (m.summary) {
        const text = m.parts.map(p => (p.type === 'text' ? p.text : '')).join('')
        parts.push({ type: 'text', text: `<conversation_summary>\nThe earlier part of this conversation was condensed to save context. Summary:\n\n${text}\n</conversation_summary>` })
      } else {
        for (const p of m.parts) {
          if (p.type === 'text') parts.push({ type: 'text', text: p.text })
          else if (p.type === 'image') parts.push({ type: 'image', mime: p.mime, data: p.data })
        }
      }
      if (parts.length) out.push({ role: 'user', content: parts })
    } else {
      const toolParts = m.parts.filter((p): p is ToolPart => p.type === 'tool')
      const text = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
      const reasoning: ReasoningBlock[] = m.parts.filter(p => p.type === 'reasoning' && (p.signature || p.redacted)).map(p => { const r = p as { text: string; signature?: string; redacted?: string }; return { text: r.text, signature: r.signature, redacted: r.redacted } })
      if (!text && !toolParts.length) continue
      out.push({ role: 'assistant', text, reasoning: reasoning.length ? reasoning : undefined, toolCalls: toolParts.length ? toolParts.map(t => ({ id: t.id, name: t.name, input: t.input, providerMeta: t.providerMeta })) : undefined })
      for (const t of toolParts) {
        const r = toolPartResult(t)
        out.push({ role: 'tool', toolCallId: t.id, name: t.name, content: r.content, isError: r.isError, images: t.meta?.images })
      }
    }
  }
  return out
}

export function estimateChatTokens(msgs: ChatMessage[], system: string, tools: ToolSpec[]): number {
  let n = estimateTokens(system) + estimateTokens(JSON.stringify(tools)) + 16
  for (const m of msgs) {
    n += 6
    if (m.role === 'user') for (const c of m.content) n += c.type === 'text' ? estimateTokens(c.text) : IMAGE_TOKENS
    else if (m.role === 'assistant') { n += estimateTokens(m.text); for (const t of m.toolCalls ?? []) n += estimateTokens(t.name) + estimateTokens(JSON.stringify(t.input ?? {})) + 8 }
    else { n += estimateTokens(m.content); n += (m.images?.length ?? 0) * IMAGE_TOKENS }
  }
  return n
}

function gitBranch(root: string): string | null {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    return head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 8) + ' (detached)'
  } catch { return null }
}

export interface PromptInput {
  agent: AgentConfig
  root: string
  hasProject: boolean
  settings: Settings
  instructions: InstructionFile[]
  memory: { project: string; global: string }
  isSub: boolean
}

export function buildSystemPrompt(i: PromptInput): string {
  const sh = defaultShell(i.settings.terminal.shell)
  const branch = i.hasProject ? gitBranch(i.root) : null
  const plat = process.platform === 'win32' ? `Windows (${os.release()}, ${process.arch})` : process.platform === 'darwin' ? `macOS (${os.release()})` : `Linux (${os.release()})`
  const parts: string[] = [BASE_PROMPT]
  if (i.agent.prompt.trim()) parts.push(`# Your role: ${i.agent.name}\n${i.agent.prompt.trim()}`)
  if (i.isSub) parts.push('You are running as a sub-agent: you cannot ask the user questions. Work autonomously and finish with a complete report as your last message.')
  parts.push(`# Environment
- Project root (working directory): ${i.root}${i.hasProject ? '' : '  (no project is open – this is a scratch folder)'}
- Platform: ${plat}
- Shell used by the shell tool: ${sh.name}${sh.kind === 'powershell' ? ' – use PowerShell syntax (e.g. Get-ChildItem, ;), not bash' : sh.kind === 'cmd' ? ' – use cmd syntax' : ''}
- Git repository: ${branch ? `yes (branch: ${branch})` : existsSync(join(i.root, '.git')) ? 'yes' : 'no'}
- Today's date: ${new Date().toISOString().slice(0, 10)}`)
  const rules = i.agent.contextRules
  if (rules?.projectInstructions !== false && i.instructions.length) {
    parts.push('# Project instructions\nThese files were written by the user for AI agents working in this project. Follow them.\n' + i.instructions.map(f => `<instructions file="${f.path}">\n${f.content.trim()}\n</instructions>`).join('\n'))
  }
  if (rules?.memory !== false && (i.memory.project.trim() || i.memory.global.trim())) {
    const mem = [i.memory.global.trim() && `Global memory:\n${i.memory.global.trim().slice(0, 6000)}`, i.memory.project.trim() && `Project memory:\n${i.memory.project.trim().slice(0, 8000)}`].filter(Boolean).join('\n\n')
    parts.push(`# Memory\nFacts saved from earlier sessions (update them with the memory tool when you learn something durable):\n${mem}`)
  }
  if (rules?.extraInstructions) parts.push(rules.extraInstructions)
  if (i.settings.ai.responseLanguage) parts.push(`Always answer in ${i.settings.ai.responseLanguage} unless the user asks otherwise.`)
  if (i.settings.ai.systemPromptSuffix.trim()) parts.push(i.settings.ai.systemPromptSuffix.trim())
  return parts.join('\n\n')
}

/** Plain-text rendering of messages for the summarizer. */
export function renderTranscript(messages: Message[], maxChars = 120_000): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.notice) continue
    if (m.role === 'user') {
      const t = m.parts.filter(p => p.type === 'text' && (!p.synthetic || m.summary)).map(p => (p as { text: string }).text).join('\n').trim()
      if (t) lines.push(`## ${m.summary ? 'Earlier summary' : 'User'}\n${t}`)
    } else {
      const t = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n').trim()
      if (t) lines.push(`## Assistant\n${t}`)
      for (const p of m.parts) if (p.type === 'tool') {
        const args = JSON.stringify(p.input)
        lines.push(`### Tool ${p.name}(${args.length > 400 ? args.slice(0, 400) + '…' : args}) → ${p.state}\n${(p.output ?? '').slice(0, 700)}${(p.output?.length ?? 0) > 700 ? '…' : ''}`)
      }
    }
  }
  let text = lines.join('\n\n')
  if (text.length > maxChars) text = '… [earlier part omitted] …\n' + text.slice(text.length - maxChars)
  return text
}
