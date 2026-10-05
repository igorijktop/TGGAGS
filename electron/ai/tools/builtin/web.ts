import { z } from 'zod'
import { defineTool, ToolError } from '../types'
import { httpFetch } from '../../providers/http'
import { htmlToMarkdown, extractTitle, decodeEntities } from '../html'
import { truncateOutput } from '../util'
import { credentials } from '../../../services/credentials'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 TGGAGS-IDE'

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { throw new ToolError(`Invalid URL: ${url}`) }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number, signal: AbortSignal): Promise<Response> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await httpFetch(url, { ...init, signal: ac.signal }) }
  catch (e) { throw new ToolError(ac.signal.aborted ? (signal.aborted ? 'Cancelled.' : `Request timed out after ${ms / 1000}s.`) : `Request failed: ${(e as Error).cause ? ((e as Error).cause as Error).message : (e as Error).message}`) }
  finally { clearTimeout(t); signal.removeEventListener('abort', onAbort) }
}

export const webfetchTool = defineTool({
  name: 'webfetch',
  category: 'web',
  readOnly: true,
  timeoutMs: 60_000,
  description: `Fetch a web page or API endpoint and return its content as Markdown (default), plain text, or raw HTML. Use it to read documentation, issues, or any URL the user gives you.
HTTP and HTTPS only. Large pages are truncated – use maxChars to see more.`,
  schema: z.object({
    url: z.string().describe('The URL to fetch (http or https)'),
    format: z.enum(['markdown', 'text', 'html']).optional().describe('Output format (default markdown)'),
    maxChars: z.number().int().min(1000).max(400_000).optional().describe('Maximum characters to return')
  }),
  describe(i) {
    if (!/^https?:\/\//i.test(i.url)) throw new ToolError('URL must start with http:// or https://')
    const host = hostOf(i.url)
    return { title: `Fetching ${host}`, checks: [{ category: 'web', resources: [host], title: `Fetch ${i.url}`, detail: i.url }] }
  },
  async execute(i, ctx) {
    const res = await fetchWithTimeout(i.url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'en' }, redirect: 'follow' }, 30_000, ctx.signal)
    if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${i.url}`)
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (/^image\//.test(type)) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 6 * 1024 * 1024) throw new ToolError('Image is larger than 6 MB.')
      return { output: `Image from ${i.url} (${type}, ${buf.length} bytes) is attached.`, images: [{ mime: type.split(';')[0], data: buf.toString('base64') }] }
    }
    if (/pdf|zip|octet-stream|video|audio|font/.test(type)) throw new ToolError(`Unsupported content type ${type}.`)
    const raw = await res.text()
    if (raw.length > 8_000_000) throw new ToolError('Response is larger than 8 MB.')
    const max = i.maxChars ?? ctx.settings.web.maxFetchChars
    const fmt = i.format ?? 'markdown'
    let body: string
    if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
      const title = extractTitle(raw)
      body = fmt === 'html' ? raw : fmt === 'text' ? htmlToMarkdown(raw, res.url).replace(/[#*`>]|\[([^\]]*)\]\([^)]*\)/g, '$1') : htmlToMarkdown(raw, res.url)
      if (title && fmt !== 'html') body = `# ${title}\n\n${body}`
    } else if (/json/.test(type)) {
      try { body = JSON.stringify(JSON.parse(raw), null, 2) } catch { body = raw }
    } else body = raw
    const cut = body.length > max
    const text = cut ? body.slice(0, max) + `\n\n… [truncated: ${body.length} characters total; pass a larger maxChars to read more]` : body
    return { output: text, title: `Fetched ${hostOf(i.url)}`, meta: { truncated: cut } }
  }
})

interface SearchHit { title: string; url: string; snippet: string }

async function duckduckgo(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'text/html', 'accept-language': 'en' }, body: new URLSearchParams({ q: query }).toString()
  }, 20_000, signal)
  if (!res.ok) throw new ToolError(`DuckDuckGo returned HTTP ${res.status}. Configure another search provider in Settings → AI → Web.`)
  const html = await res.text()
  if (/anomaly|captcha|unusual traffic/i.test(html) && !/result__a/.test(html)) throw new ToolError('DuckDuckGo is rate-limiting this computer. Try again later or configure Brave/Tavily/SearXNG in Settings.')
  const hits: SearchHit[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && hits.length < n) {
    let url = decodeEntities(m[1])
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) url = decodeURIComponent(u[1])
    else if (url.startsWith('//')) url = 'https:' + url
    if (!/^https?:/.test(url)) continue
    hits.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(), url, snippet: decodeEntities((m[3] ?? m[4] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() })
  }
  return hits
}

async function brave(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = credentials.get('web:brave') ?? process.env.BRAVE_API_KEY
  if (!key) throw new ToolError('Brave Search needs an API key (Settings → AI → Web).')
  const res = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, { headers: { 'x-subscription-token': key, accept: 'application/json' } }, 20_000, signal)
  if (!res.ok) throw new ToolError(`Brave Search error ${res.status}`)
  const j = await res.json() as { web?: { results?: { title: string; url: string; description?: string }[] } }
  return (j.web?.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: decodeEntities((r.description ?? '').replace(/<[^>]+>/g, '')) }))
}

async function tavily(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = credentials.get('web:tavily') ?? process.env.TAVILY_API_KEY
  if (!key) throw new ToolError('Tavily needs an API key (Settings → AI → Web).')
  const res = await fetchWithTimeout('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ query, max_results: n }) }, 25_000, signal)
  if (!res.ok) throw new ToolError(`Tavily error ${res.status}`)
  const j = await res.json() as { results?: { title: string; url: string; content?: string }[] }
  return (j.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 300) }))
}

async function searxng(base: string, query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  if (!base) throw new ToolError('Set the SearXNG URL in Settings → AI → Web.')
  const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { accept: 'application/json' } }, 20_000, signal)
  if (!res.ok) throw new ToolError(`SearXNG error ${res.status}`)
  const j = await res.json() as { results?: { title: string; url: string; content?: string }[] }
  return (j.results ?? []).slice(0, n).map(r => ({ title: r.title, url: r.url, snippet: r.content ?? '' }))
}

export const websearchTool = defineTool({
  name: 'websearch',
  category: 'web',
  readOnly: true,
  timeoutMs: 60_000,
  description: 'Search the web and return titles, URLs and snippets. Use webfetch afterwards to read a result in full. Good for current events, library documentation and error messages.',
  schema: z.object({ query: z.string().min(2).describe('Search query'), maxResults: z.number().int().min(1).max(15).optional().describe('Number of results (default 8)') }),
  describe(i, ctx) {
    const p = ctx.settings.web.searchProvider
    const host = p === 'duckduckgo' ? 'duckduckgo.com' : p === 'brave' ? 'api.search.brave.com' : p === 'tavily' ? 'api.tavily.com' : (() => { try { return new URL(ctx.settings.web.searxngUrl).hostname } catch { return 'searxng' } })()
    return { title: `Searching the web: ${i.query.slice(0, 50)}`, checks: [{ category: 'web', toolName: 'websearch', resources: [host], title: `Search the web for "${i.query}"`, detail: `via ${p}` }] }
  },
  async execute(i, ctx) {
    const n = i.maxResults ?? 8
    const p = ctx.settings.web.searchProvider
    const hits = p === 'brave' ? await brave(i.query, n, ctx.signal) : p === 'tavily' ? await tavily(i.query, n, ctx.signal) : p === 'searxng' ? await searxng(ctx.settings.web.searxngUrl, i.query, n, ctx.signal) : await duckduckgo(i.query, n, ctx.signal)
    if (!hits.length) return { output: `No results for "${i.query}".`, title: 'No results' }
    const out = hits.map((h, k) => `${k + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n')
    const t = await truncateOutput(out, { save: false })
    return { output: t.text, title: `${hits.length} results`, meta: { matches: hits.length } }
  }
})
