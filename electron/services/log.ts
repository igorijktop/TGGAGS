import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { emit } from './events'
import { dataPath } from './paths'

export interface LogLine { ts: number; channel: string; level: 'info' | 'warn' | 'error' | 'debug'; text: string }

const MAX_LINES = 2000
const buffers = new Map<string, LogLine[]>()
let fileReady: Promise<unknown> | null = null

function write(channel: string, level: LogLine['level'], text: string): void {
  const line: LogLine = { ts: Date.now(), channel, level, text }
  let buf = buffers.get(channel)
  if (!buf) { buf = []; buffers.set(channel, buf) }
  buf.push(line)
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES)
  emit('output:line', line)
  fileReady ??= mkdir(dataPath('logs'), { recursive: true }).catch(() => undefined)
  void fileReady.then(() => appendFile(join(dataPath('logs'), 'app.log'), `${new Date(line.ts).toISOString()} [${channel}] ${level.toUpperCase()} ${text}\n`).catch(() => undefined))
}

export const log = {
  info: (channel: string, text: string) => write(channel, 'info', text),
  warn: (channel: string, text: string) => write(channel, 'warn', text),
  error: (channel: string, text: string) => write(channel, 'error', text),
  debug: (channel: string, text: string) => write(channel, 'debug', text),
  channels: () => [...buffers.keys()],
  get: (channel: string) => buffers.get(channel) ?? [],
  clear: (channel: string) => { buffers.delete(channel); emit('output:cleared', channel) }
}
