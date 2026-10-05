import type { BenchCase, BenchResult } from '../../shared/ai'
import type { BenchApi, BenchRunRequest } from '../../shared/media'
import { refKey } from '../../shared/settings'
import { settings } from '../services/settings'
import { dataPath } from '../services/paths'
import { readJson, writeJson, uid } from '../services/storage'
import { emit } from '../services/events'
import { createProvider, findModel, type StreamEvent } from './providers'

const NEEDLE_FILLER = Array.from({ length: 220 }, (_, i) => `Paragraph ${i + 1}: The archive describes routine inventory counts, shipping schedules and maintenance logs for facility ${i % 7}. Nothing unusual occurred.`)
NEEDLE_FILLER.splice(137, 0, 'IMPORTANT NOTE: the vault access phrase is "ZEBRA-4471" and must not be shared outside the audit team.')

export const BENCH_CASES: BenchCase[] = [
  { id: 'code-fizzbuzz', category: 'Coding', name: 'Write a function', prompt: 'Write a Python function fizzbuzz(n) that returns a list of strings for 1..n using the classic rules. Reply with only the code in one code block.', check: { type: 'regex', value: 'def\\s+fizzbuzz[\\s\\S]*(FizzBuzz)' } },
  { id: 'code-bug', category: 'Coding', name: 'Find the bug', prompt: 'This JavaScript has a bug. Name the bug in one sentence.\n\nfunction sum(arr){ let t=0; for(let i=0;i<=arr.length;i++){ t+=arr[i] } return t }', check: { type: 'regex', value: '(<=|off[- ]by[- ]one|out of bounds|undefined|NaN|length)' } },
  { id: 'reasoning', category: 'Reasoning', name: 'Bat and ball', prompt: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Answer with just the amount.', check: { type: 'regex', value: '(0?\\.05|5 ?(c|¢|cents))' } },
  { id: 'json', category: 'Format', name: 'Strict JSON', prompt: 'Return ONLY a JSON object (no markdown) with keys "name" (string) and "tags" (array of exactly 3 strings) describing a cat.', check: { type: 'json' } },
  { id: 'instruction', category: 'Instruction following', name: 'Exact constraints', prompt: 'Reply with exactly three words, all lowercase, no punctuation, describing the ocean.', check: { type: 'regex', value: '^\\s*[a-z]+ [a-z]+ [a-z]+\\s*$' } },
  { id: 'needle', category: 'Long context', name: 'Needle in a haystack', prompt: `${NEEDLE_FILLER.join('\n')}\n\nQuestion: what is the vault access phrase mentioned in the text above? Answer with just the phrase.`, check: { type: 'contains', value: 'ZEBRA-4471' } },
  { id: 'multilingual', category: 'Language', name: 'Translate to Russian', prompt: 'Translate to Russian, answer with only the translation: "The quick brown fox jumps over the lazy dog."', check: { type: 'regex', value: '[А-Яа-яЁё]{3,}' } }
]

const TOOL_CASE: BenchCase = { id: 'tool-call', category: 'Tools', name: 'Tool calling', prompt: 'What is the weather in Paris right now? Use the provided tool.', check: { type: 'contains', value: 'get_weather' } }
BENCH_CASES.push(TOOL_CASE)

let cancelFlag: AbortController | null = null
let cached: BenchResult[] | null = null
const file = () => dataPath('benchmarks.json')
const load = async () => (cached ??= await readJson<BenchResult[]>(file(), []))

function passed(c: BenchCase, text: string, toolNames: string[]): boolean | undefined {
  if (!c.check) return undefined
  if (c.id === 'tool-call') return toolNames.includes('get_weather')
  if (c.check.type === 'contains') return text.includes(c.check.value ?? '')
  if (c.check.type === 'regex') return new RegExp(c.check.value ?? '', 'i').test(text)
  if (c.check.type === 'json') { try { const j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); return typeof j.name === 'string' && Array.isArray(j.tags) && j.tags.length === 3 } catch { return false } }
  return undefined
}

export const benchApi: BenchApi = {
  async cases() { return BENCH_CASES },
  async results() { return load() },
  async clear() { cached = []; await writeJson(file(), []) },
  async cancel() { cancelFlag?.abort() },
  async run(req: BenchRunRequest) {
    cancelFlag?.abort()
    const ac = (cancelFlag = new AbortController())
    const s = settings.get()
    const cases = BENCH_CASES.filter(c => req.caseIds.includes(c.id))
    const all = await load()
    const out: BenchResult[] = []
    const total = req.models.length * cases.length * (req.runs ?? 1)
    let done = 0
    for (const ref of req.models) {
      for (const c of cases) {
        for (let run = 0; run < (req.runs ?? 1); run++) {
          if (ac.signal.aborted) break
          emit('bench:progress', { done, total, current: `${ref.model} · ${c.name}` })
          const t0 = Date.now()
          let ttft: number | undefined
          let text = ''
          const tools: string[] = []
          let inTok = 0, outTok = 0
          const result: BenchResult = { id: uid('b-'), caseId: c.id, model: ref, ok: false, totalMs: 0, inputTokens: 0, outputTokens: 0, tokensPerSec: 0, ts: Date.now() }
          try {
            const { provider, info } = findModel(ref, s)
            const p = createProvider(provider)
            const stream = p.streamChat({
              model: ref.model, modelInfo: info, messages: [{ role: 'user', content: [{ type: 'text', text: c.prompt }] }], maxTokens: 1200, reasoning: 'off', signal: ac.signal, idleTimeoutMs: 120_000,
              tools: c.id === 'tool-call' ? [{ name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] : undefined
            })
            for await (const ev of stream as AsyncIterable<StreamEvent>) {
              if ((ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_start') && ttft === undefined) ttft = Date.now() - t0
              if (ev.type === 'text') text += ev.delta
              else if (ev.type === 'tool_call') tools.push(ev.name)
              else if (ev.type === 'usage') { inTok = ev.input; outTok = ev.output }
            }
            result.ok = true
            result.passed = passed(c, text, tools)
            result.excerpt = (text || tools.map(t => `[tool call: ${t}]`).join(' ')).slice(0, 240)
          } catch (e) { result.error = (e as Error).message.slice(0, 300) }
          result.totalMs = Date.now() - t0
          result.ttftMs = ttft
          result.inputTokens = inTok; result.outputTokens = outTok || Math.ceil(text.length / 4)
          const genMs = Math.max(1, result.totalMs - (ttft ?? 0))
          result.tokensPerSec = result.ok ? Math.round((result.outputTokens / genMs) * 1000 * 10) / 10 : 0
          const info = findModelSafe(ref)
          if (info && (info.inputPrice != null || info.outputPrice != null)) result.cost = (inTok * (info.inputPrice ?? 0) + result.outputTokens * (info.outputPrice ?? 0)) / 1_000_000
          out.push(result); all.push(result); done++
          emit('bench:result', result)
        }
      }
    }
    await writeJson(file(), all.slice(-2000))
    emit('bench:progress', { done: total, total })
    cancelFlag = null
    void refKey
    return out
  }
}

function findModelSafe(ref: { provider: string; model: string }) { try { return findModel(ref).info } catch { return undefined } }
