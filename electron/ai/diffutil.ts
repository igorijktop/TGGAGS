import { createTwoFilesPatch, diffLines } from 'diff'

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const part of diffLines(before, after)) {
    const n = part.count ?? part.value.split('\n').length - 1
    if (part.added) added += n
    else if (part.removed) removed += n
  }
  return { added, removed }
}

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  return createTwoFilesPatch(path, path, before, after, '', '', { context }).replace(/^Index:.*\n=+\n/, '')
}

/** Compact diff for tool output: only the changed hunks, capped. */
export function diffSnippet(path: string, before: string, after: string, maxLines = 60): string {
  const lines = unifiedDiff(path, before, after, 2).split('\n').slice(2)
  const body = lines.slice(0, maxLines).join('\n')
  return lines.length > maxLines ? `${body}\n… (${lines.length - maxLines} more diff lines)` : body
}
