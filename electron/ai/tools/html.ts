// Small dependency-free HTML → Markdown converter for the webfetch tool.

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', middot: '·' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try { return String.fromCodePoint(code) } catch { return m }
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html
  const mainM = s.match(/<(main|article)[\s>][\s\S]*<\/\1>/i)
  if (mainM && mainM[0].length > 800) s = mainM[0]
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head|form|button|select|canvas)[\s\S]*?<\/\1>/gi, '')
  const abs = (u: string): string => { try { return baseUrl ? new URL(u, baseUrl).toString() : u } catch { return u } }
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    return `\n\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`
  })
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => '`' + decodeEntities(inner.replace(/<[^>]+>/g, '')) + '`')
  for (let n = 1; n <= 6; n++) s = s.replace(new RegExp(`<h${n}[^>]*>([\\s\\S]*?)</h${n}>`, 'gi'), (_m, t: string) => `\n\n${'#'.repeat(n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    const text = t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    return text && !href.startsWith('javascript:') && !href.startsWith('#') ? `[${text}](${abs(href)})` : text
  })
  s = s.replace(/<img\s[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, a: string) => (a ? `[image: ${a}]` : ''))
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(ul|ol)>/gi, '\n')
  s = s.replace(/<tr[^>]*>/gi, '\n').replace(/<\/t[hd]>/gi, ' | ').replace(/<t[hd][^>]*>/gi, '')
  s = s.replace(/<blockquote[^>]*>/gi, '\n> ').replace(/<hr\s*\/?>/gi, '\n---\n')
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|header|footer|tr|table|figure|ul|ol|dl|dt|dd)>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return s
}
