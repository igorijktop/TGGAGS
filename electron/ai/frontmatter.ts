import YAML from 'yaml'

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { data: {}, body: text }
  try {
    const data = YAML.parse(m[1])
    return { data: data && typeof data === 'object' ? data as Record<string, unknown> : {}, body: m[2] }
  } catch { return { data: {}, body: m[2] } }
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(data).trimEnd()}\n---\n\n${body.trim()}\n`
}
