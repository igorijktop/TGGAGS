import { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'

/** Main-process internal event bus (service ↔ service). */
export const bus = new EventEmitter()
bus.setMaxListeners(100)

/** Broadcast an event to every renderer window. */
export function emit(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('evt', channel, payload)
  }
  bus.emit(channel, payload)
}
