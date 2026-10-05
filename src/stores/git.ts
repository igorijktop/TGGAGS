import { create } from 'zustand'
import type { GitStatus } from '@shared/dev'
import { api, onEvent } from '../lib/api'
import { debounce } from '../lib/util'
import { useWorkspace } from './workspace'

interface GitState {
  status: GitStatus | null
  busy: string | null
  lastError: string | null
  refresh(): Promise<void>
  run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>
}

const EMPTY = null as GitStatus | null

export const useGit = create<GitState>((set, get) => ({
  status: EMPTY, busy: null, lastError: null,
  async refresh() {
    if (!useWorkspace.getState().root) { set({ status: null }); return }
    try { set({ status: await api.git.status(), lastError: null }) } catch (e) { set({ lastError: (e as Error).message }) }
  },
  async run(label, fn) {
    set({ busy: label, lastError: null })
    try { return await fn() }
    catch (e) { set({ lastError: (e as Error).message }); throw e }
    finally { set({ busy: null }); void get().refresh() }
  }
}))

export function initGit(): void {
  const refresh = debounce(() => { void useGit.getState().refresh() }, 600)
  onEvent('git:changed', refresh)
  onEvent('fs:changed', refresh)
  onEvent('workspace:changed', () => { useGit.setState({ status: null }); refresh() })
  window.addEventListener('focus', refresh)
  void useGit.getState().refresh()
}
