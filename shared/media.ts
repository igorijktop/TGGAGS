import type { ModelRef } from './settings'
import type { BenchCase, BenchResult } from './ai'

export type AssetKind = 'generated' | 'edited' | 'upscaled' | 'imported'
export interface AssetMeta {
  id: string
  file: string
  mime: string
  size: number
  width?: number
  height?: number
  kind: AssetKind
  name: string
  prompt?: string
  negativePrompt?: string
  model?: ModelRef
  params?: Record<string, unknown>
  parentId?: string
  tags: string[]
  favorite: boolean
  createdAt: number
}

export interface ImageRequest {
  mode: 'generate' | 'edit' | 'variation'
  model: ModelRef
  prompt: string
  negativePrompt?: string
  size?: string
  aspectRatio?: string
  n?: number
  seed?: number
  steps?: number
  guidance?: number
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
  style?: string
  format?: 'png' | 'jpeg' | 'webp'
  strength?: number
  /** asset ids or raw data for edit / variation */
  inputAssetId?: string
  inputImage?: { mime: string; data: string }
  maskImage?: { mime: string; data: string }
}

export interface ImageApi {
  generate(req: ImageRequest): Promise<AssetMeta[]>
  cancel(): Promise<void>
  upscale(assetId: string, scale: number, model?: ModelRef): Promise<AssetMeta>
  describe(assetId: string, prompt?: string): Promise<string>
  ocr(assetId: string): Promise<string>
  listAssets(): Promise<AssetMeta[]>
  importFiles(paths: string[]): Promise<AssetMeta[]>
  importData(name: string, mime: string, base64: string, kind?: AssetKind, parentId?: string, prompt?: string): Promise<AssetMeta>
  updateAsset(id: string, patch: Partial<Pick<AssetMeta, 'name' | 'tags' | 'favorite'>>): Promise<AssetMeta | null>
  deleteAsset(id: string): Promise<void>
  exportAsset(id: string, destPath: string): Promise<void>
  saveToProject(id: string, relPath: string): Promise<string>
  assetPath(id: string): Promise<string>
  a1111Models(modelProviderId: string): Promise<string[]>
}

export interface BenchRunRequest { models: ModelRef[]; caseIds: string[]; runs?: number }
export interface BenchProgress { done: number; total: number; current?: string }
export interface BenchApi {
  cases(): Promise<BenchCase[]>
  run(req: BenchRunRequest): Promise<BenchResult[]>
  cancel(): Promise<void>
  results(): Promise<BenchResult[]>
  clear(): Promise<void>
}

// ───────────── GitHub ─────────────
export interface GhUser { login: string; name?: string; avatar: string; url: string }
export interface GhRepoRef { owner: string; repo: string }
export interface GhPull { number: number; title: string; state: string; draft: boolean; author: string; head: string; base: string; url: string; updated: string; comments: number; merged?: boolean; body?: string; mergeable?: boolean | null; additions?: number; deletions?: number; changedFiles?: number }
export interface GhIssue { number: number; title: string; state: string; author: string; labels: { name: string; color: string }[]; url: string; updated: string; comments: number; body?: string }
export interface GhRun { id: number; name: string; status: string; conclusion: string | null; branch: string; event: string; url: string; created: string; sha: string }
export interface GhComment { author: string; body: string; created: string; url: string }
export interface GhCheck { name: string; status: string; conclusion: string | null; url?: string }

export interface GithubApi {
  status(): Promise<{ authenticated: boolean; user?: GhUser; repo?: GhRepoRef | null; error?: string }>
  setToken(token: string): Promise<{ ok: boolean; user?: GhUser; error?: string }>
  logout(): Promise<void>
  repos(): Promise<{ full: string; description: string; private: boolean; url: string; cloneUrl: string; updated: string; stars: number }[]>
  pulls(state: 'open' | 'closed' | 'all'): Promise<GhPull[]>
  pull(number: number): Promise<{ pull: GhPull; files: { path: string; status: string; additions: number; deletions: number; patch?: string }[]; comments: GhComment[]; checks: GhCheck[] }>
  createPull(o: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<GhPull>
  mergePull(number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void>
  issues(state: 'open' | 'closed' | 'all'): Promise<GhIssue[]>
  issue(number: number): Promise<{ issue: GhIssue; comments: GhComment[] }>
  createIssue(title: string, body: string, labels?: string[]): Promise<GhIssue>
  comment(number: number, body: string): Promise<void>
  runs(): Promise<GhRun[]>
  defaultBranch(): Promise<string>
}
