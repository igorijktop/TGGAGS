import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, promises as fsp } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJsonSync(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** A JSON file with debounced, atomic persistence. */
export class JsonStore<T extends object> {
  private timer: NodeJS.Timeout | null = null
  value: T
  constructor(private file: string, defaults: T, private delay = 250) {
    this.value = { ...defaults, ...readJsonSync<Partial<T>>(file, {}) }
  }
  save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.delay)
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    try { writeJsonSync(this.file, this.value) } catch (e) { console.error('JsonStore flush failed', this.file, e) }
  }
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v)
    else out[k] = v
  }
  return out as T
}

export function uid(prefix = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
