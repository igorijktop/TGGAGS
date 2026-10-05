// Splitting shell command lines into the individual commands a permission rule should judge.

export interface ParsedCommand {
  segments: string[]
  /** contains redirections, command substitution or other constructs that can hide side effects */
  risky: boolean
}

export function parseCommand(command: string): ParsedCommand {
  const segments: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let risky = false
  const flush = () => { const t = cur.trim(); if (t) segments.push(t); cur = '' }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const n = command[i + 1]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && n) { cur += n; i++; continue }
      if (c === quote) quote = null
      else if (quote === '"' && (c === '`' || (c === '$' && n === '('))) risky = true
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '`' || (c === '$' && n === '(') || (c === '<' && n === '(')) risky = true
    if (c === '>' ) {
      const prev = command[i - 1]
      const rest = command.slice(i, i + 12)
      const harmless = /^>&\d/.test(rest) || /^>\s*(\/dev\/null|nul\b|\$null)/i.test(rest) || (prev === '2' && /^>&/.test(rest)) || /^2>&1/.test(command.slice(i - 1, i + 3))
      if (!harmless) risky = true
    }
    if (c === '&' && n === '&') { flush(); i++; continue }
    if (c === '|' && n === '|') { flush(); i++; continue }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '&' && n !== '>')) { flush(); continue }
    cur += c
  }
  flush()
  return { segments, risky }
}

/** "git -C repo -c k=v --no-pager commit -m x"  →  { sub: "commit", rest: "commit -m x" } */
export function gitSubcommand(segment: string): { sub: string; rest: string } | null {
  const m = segment.match(/^\s*(?:\S*[\\/])?git(?:\.exe)?\s+(.*)$/i)
  if (!m) return null
  const toks = m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  let i = 0
  while (i < toks.length && toks[i].startsWith('-')) {
    if (toks[i] === '-C' || toks[i] === '-c' || toks[i] === '--git-dir' || toks[i] === '--work-tree') i += 2
    else i++
  }
  if (i >= toks.length) return { sub: '', rest: '' }
  return { sub: toks[i], rest: toks.slice(i).join(' ') }
}
