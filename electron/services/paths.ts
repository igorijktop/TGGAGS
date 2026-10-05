import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** Global (per-user) data directory. Overridable for tests via TGG_USER_DATA. */
export function userDir(): string {
  return process.env.TGG_USER_DATA || app.getPath('userData')
}

export function dataPath(...parts: string[]): string {
  return join(userDir(), ...parts)
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dataDir(...parts: string[]): string {
  return ensureDir(dataPath(...parts))
}

/** Folder name used for project-level configuration */
export const PROJECT_DIR = '.tgg'
