import { create } from 'zustand'
import type { LspServerStatus } from '@shared/dev'
import { api, onEvent } from '../lib/api'

export const useLspStatus = create<{ servers: LspServerStatus[]; refresh(): Promise<void> }>((set) => ({
  servers: [],
  async refresh() { set({ servers: await api.lsp.status().catch(() => []) }) }
}))

export function initLspStatus(): void {
  void useLspStatus.getState().refresh()
  onEvent('lsp:status', s => { if (s) useLspStatus.setState({ servers: s }); else void useLspStatus.getState().refresh() })
  setInterval(() => { void useLspStatus.getState().refresh() }, 8000)
}
