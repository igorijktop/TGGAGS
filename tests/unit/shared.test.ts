import { describe, expect, it } from 'vitest'
import { THEMES } from '../../shared/themes'
import { PROVIDER_PRESETS, presetToProvider } from '../../shared/presets'
import { defaultPermissionRules, defaultSettings, refKey, sameRef } from '../../shared/settings'
import { deepMerge, formatDuration, formatTokens, fuzzy, relativeTo, timeAgo } from '../../src/lib/util'

function channel(c: number) { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
function luminance(hex: string) { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255) }
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

describe('themes', () => {
  it('define the same set of tokens', () => {
    const keys = Object.keys(THEMES[0].ui).sort()
    for (const t of THEMES) expect(Object.keys(t.ui).sort(), t.id).toEqual(keys)
  })
  it('keep text readable (WCAG AA 4.5:1 for body and muted text on every surface)', () => {
    for (const t of THEMES) for (const bg of ['--bg', '--bg-sidebar', '--bg-elevated']) {
      expect(contrast(t.ui['--fg'], t.ui[bg]), `${t.id} fg on ${bg}`).toBeGreaterThanOrEqual(7)
      expect(contrast(t.ui['--fg-muted'], t.ui[bg]), `${t.id} muted on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('keep syntax colours legible on the editor background', () => {
    for (const t of THEMES) for (const [k, v] of Object.entries(t.syntax)) {
      if (k === 'comment' || k === 'punctuation') expect(contrast(v, t.ui['--bg']), `${t.id} ${k}`).toBeGreaterThanOrEqual(3)
      else expect(contrast(v, t.ui['--bg']), `${t.id} ${k}`).toBeGreaterThanOrEqual(3.8)
    }
  })
  it('buttons with the accent colour stay readable', () => {
    for (const t of THEMES) expect(contrast(t.ui['--accent-fg'], t.ui['--accent-strong']), t.id).toBeGreaterThanOrEqual(4.5)
  })
  it('keep accent-coloured text readable on the page background', () => {
    for (const t of THEMES) expect(contrast(t.kind === 'light' ? t.ui['--accent-strong'] : t.ui['--accent'], t.ui['--bg']), t.id).toBeGreaterThanOrEqual(4.5)
  })
})

describe('provider presets', () => {
  it('have unique ids and valid models', () => {
    const ids = PROVIDER_PRESETS.map(p => p.presetId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PROVIDER_PRESETS) for (const m of p.models) expect(['chat', 'image', 'embedding']).toContain(m.modality)
  })
  it('turn into independent provider configs', () => {
    const a = presetToProvider(PROVIDER_PRESETS[0], 'x'), b = presetToProvider(PROVIDER_PRESETS[0], 'y')
    a.models[0].name = 'changed'
    expect(b.models[0].name).not.toBe('changed')
    expect(a.enabled).toBe(true)
  })
  it('include local providers that need no key', () => {
    expect(PROVIDER_PRESETS.filter(p => p.local && !p.requiresKey).length).toBeGreaterThanOrEqual(3)
  })
})

describe('settings', () => {
  it('default to a safe permission set', () => {
    const rules = defaultPermissionRules()
    expect(rules.some(r => r.tool === 'read' && r.action === 'deny' && r.pattern === '**/.env')).toBe(true)
    expect(rules.some(r => r.tool === 'shell' && r.action === 'ask' && !r.pattern)).toBe(true)
    expect(rules.some(r => r.tool === 'edit' && r.action === 'ask' && !r.pattern)).toBe(true)
    expect(rules.some(r => r.tool === 'shell' && r.action === 'deny' && r.pattern === 'rm -rf /')).toBe(true)
  })
  it('compare model references', () => {
    expect(refKey({ provider: 'a', model: 'b' })).toBe('a::b')
    expect(sameRef({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' })).toBe(true)
    expect(sameRef(null, { provider: 'a', model: 'b' })).toBe(false)
  })
  it('start without any provider or secret', () => {
    const s = defaultSettings()
    expect(s.providers).toEqual([])
    expect(JSON.stringify(s)).not.toMatch(/sk-|api[_-]?key/i)
  })
})

describe('renderer helpers', () => {
  it('fuzzy-match paths and rank basename hits first', () => {
    const a = fuzzy('idx', 'src/index.ts')!, b = fuzzy('idx', 'src/inner/deep/other-dix.ts')!
    expect(a.indices.length).toBe(3)
    expect(a.score).toBeGreaterThan(b.score)
    expect(fuzzy('zzz', 'src/index.ts')).toBeNull()
    expect(fuzzy('', 'anything')).toEqual({ score: 0, indices: [] })
  })
  it('format numbers for humans', () => {
    expect(formatTokens(950)).toBe('950'); expect(formatTokens(1500)).toBe('1.5K'); expect(formatTokens(18_442)).toBe('18K'); expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatDuration(420)).toBe('420ms'); expect(formatDuration(2400)).toBe('2.4s'); expect(formatDuration(125_000)).toBe('2m 5s')
    expect(timeAgo(Date.now() - 5_000)).toBe('just now'); expect(timeAgo(Date.now() - 3 * 3_600_000)).toBe('3h ago')
  })
  it('compute relative paths on both separators', () => {
    expect(relativeTo('/home/me/proj', '/home/me/proj/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\proj', 'C:\\Users\\me\\proj\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('/home/me/proj', '/etc/hosts')).toBe('/etc/hosts')
  })
  it('deep-merge settings patches without mutating', () => {
    const base = { a: { b: 1, c: [1] }, d: 'x' }
    const out = deepMerge(base, { a: { b: 2, c: [9] } })
    expect(out).toEqual({ a: { b: 2, c: [9] }, d: 'x' })
    expect(base.a.b).toBe(1)
  })
})
