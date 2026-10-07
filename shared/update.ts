/** What the app knows about an available release (from `release/latest.json` in the repository). */
export interface UpdateInfo {
  version: string
  notes: string
  /** bytes of the installer */
  size: number
  sha256: string
  /** absolute https URL of the installer */
  url: string
  date?: string
}

export type UpdateState = { current: string } & (
  | { status: 'idle'; checkedAt?: number }
  | { status: 'checking' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloading'; info: UpdateInfo; received: number }
  | { status: 'ready'; info: UpdateInfo }
  | { status: 'error'; message: string; info?: UpdateInfo }
)

/** "1.2.3" or "1.2.3-beta.1" → numbers + pre-release tag, null when it is not a version. */
export function parseVersion(v: string): { nums: [number, number, number]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null
}

/** <0 when a is older than b, 0 when equal, >0 when a is newer. Unparseable versions count as oldest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1 // 1.0.0 is newer than 1.0.0-beta
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}
