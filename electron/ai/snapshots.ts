import { promises as fsp } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { FileChange } from '../../shared/ai'
import { dataPath } from '../services/paths'
import { uid } from '../services/storage'
import { diffStats } from './diffutil'
import { encodeText } from '../services/fsapi'

type Content = { inline: string } | { blob: string } | null

interface ChangeRec { id: string; ts: number; turnId: string; messageId: string; toolCallId: string; path: string; before: Content; after: Content }
interface State { changes: ChangeRec[]; redo: ChangeRec[][] }

const INLINE_MAX = 64 * 1024

/** Records every file modification an agent makes so a whole turn (or a single file) can be undone and redone. */
class SnapshotStore {
  private states = new Map<string, State>()
  private dir(sessionId: string) { return dataPath('snapshots', sessionId) }

  private async load(sessionId: string): Promise<State> {
    let st = this.states.get(sessionId)
    if (st) return st
    try { st = JSON.parse(await fsp.readFile(join(this.dir(sessionId), 'index.json'), 'utf8')) as State } catch { st = { changes: [], redo: [] } }
    this.states.set(sessionId, st)
    return st
  }

  private async persist(sessionId: string): Promise<void> {
    const st = this.states.get(sessionId)
    if (!st) return
    await fsp.mkdir(this.dir(sessionId), { recursive: true })
    await fsp.writeFile(join(this.dir(sessionId), 'index.json'), JSON.stringify(st))
  }

  private async put(sessionId: string, text: string | null): Promise<Content> {
    if (text === null) return null
    if (text.length <= INLINE_MAX) return { inline: text }
    const name = `${uid('b-')}.txt`
    await fsp.mkdir(this.dir(sessionId), { recursive: true })
    await fsp.writeFile(join(this.dir(sessionId), name), text, 'utf8')
    return { blob: name }
  }

  private async get(sessionId: string, c: Content): Promise<string | null> {
    if (c === null) return null
    if ('inline' in c) return c.inline
    return fsp.readFile(join(this.dir(sessionId), c.blob), 'utf8')
  }

  async record(sessionId: string, turnId: string, messageId: string, rec: { path: string; before: string | null; after: string | null; toolCallId: string }): Promise<void> {
    const st = await this.load(sessionId)
    st.redo = []
    st.changes.push({ id: uid('c-'), ts: Date.now(), turnId, messageId, toolCallId: rec.toolCallId, path: rec.path, before: await this.put(sessionId, rec.before), after: await this.put(sessionId, rec.after) })
    await this.persist(sessionId)
  }

  async summary(sessionId: string, root: string | null): Promise<FileChange[]> {
    const st = await this.load(sessionId)
    const byPath = new Map<string, { first: ChangeRec; last: ChangeRec }>()
    for (const c of st.changes) { const e = byPath.get(c.path); if (e) e.last = c; else byPath.set(c.path, { first: c, last: c }) }
    const out: FileChange[] = []
    for (const [path, { first, last }] of byPath) {
      const before = await this.get(sessionId, first.before)
      const after = await this.get(sessionId, last.after)
      if (before === after) continue
      const { added, removed } = diffStats(before ?? '', after ?? '')
      out.push({ path, rel: root ? relative(root, path).split(sep).join('/') : path, status: before === null ? 'created' : after === null ? 'deleted' : 'modified', added, removed, messageId: last.messageId, before, after })
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  private async restore(sessionId: string, path: string, content: Content): Promise<void> {
    const text = await this.get(sessionId, content)
    if (text === null) await fsp.rm(path, { force: true })
    else { await fsp.mkdir(dirname(path), { recursive: true }); await fsp.writeFile(path, encodeText(text, 'utf8')) }
  }

  /** Undo every change recorded from `turnId` onward (newest first). */
  async revertFromTurn(sessionId: string, turnId: string | null): Promise<{ reverted: number; files: string[] }> {
    const st = await this.load(sessionId)
    let startIdx = turnId ? st.changes.findIndex(c => c.turnId === turnId) : 0
    if (startIdx < 0) return { reverted: 0, files: [] }
    const batch = st.changes.splice(startIdx)
    for (const c of [...batch].reverse()) await this.restore(sessionId, c.path, c.before)
    st.redo.push(batch)
    await this.persist(sessionId)
    return { reverted: batch.length, files: [...new Set(batch.map(c => c.path))] }
  }

  async revertLastTurn(sessionId: string): Promise<{ reverted: number; files: string[] }> {
    const st = await this.load(sessionId)
    const last = st.changes[st.changes.length - 1]
    return last ? this.revertFromTurn(sessionId, last.turnId) : { reverted: 0, files: [] }
  }

  /** Restore a single file to the content it had before the agent first touched it. */
  async revertFile(sessionId: string, path: string): Promise<boolean> {
    const st = await this.load(sessionId)
    const mine = st.changes.filter(c => c.path === path)
    if (!mine.length) return false
    await this.restore(sessionId, path, mine[0].before)
    st.changes = st.changes.filter(c => c.path !== path)
    st.redo.push(mine)
    await this.persist(sessionId)
    return true
  }

  async redo(sessionId: string): Promise<{ applied: number; files: string[] }> {
    const st = await this.load(sessionId)
    const batch = st.redo.pop()
    if (!batch) return { applied: 0, files: [] }
    for (const c of batch) await this.restore(sessionId, c.path, c.after)
    st.changes.push(...batch)
    await this.persist(sessionId)
    return { applied: batch.length, files: [...new Set(batch.map(c => c.path))] }
  }

  async canRedo(sessionId: string): Promise<boolean> { return (await this.load(sessionId)).redo.length > 0 }
  async count(sessionId: string): Promise<number> { return (await this.load(sessionId)).changes.length }
  /** Forget history (user accepted the changes). */
  async clear(sessionId: string): Promise<void> { this.states.set(sessionId, { changes: [], redo: [] }); await this.persist(sessionId) }
}

export const snapshots = new SnapshotStore()
