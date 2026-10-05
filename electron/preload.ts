import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (channel: string, payload: unknown) => void
const listeners = new Set<Listener>()
ipcRenderer.on('evt', (_e, channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload) })

contextBridge.exposeInMainWorld('tgg', {
  rpc: (path: string, args: unknown[]) => ipcRenderer.invoke('rpc', path, args),
  subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l) } },
  pathForFile: (file: File) => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  platform: process.platform,
  arch: process.arch
})
