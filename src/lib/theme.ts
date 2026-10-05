import { themeById, THEMES, type ThemeDef } from '@shared/themes'
import { api } from './api'

let extraThemes: ThemeDef[] = []
export const allThemes = (): ThemeDef[] => [...THEMES, ...extraThemes]
export function setExtraThemes(t: ThemeDef[]) { extraThemes = t }
export function findTheme(id: string): ThemeDef { return extraThemes.find(t => t.id === id) ?? themeById(id) }

export function applyTheme(id: string): ThemeDef {
  const t = findTheme(id)
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.ui)) root.style.setProperty(k, v)
  root.dataset.theme = t.id
  root.dataset.kind = t.kind
  root.style.colorScheme = t.kind
  void api.window.setTitleBarColors(t.ui['--bg-sidebar'], t.ui['--fg']).catch(() => undefined)
  return t
}

export function applyAppearance(a: { uiScale: number; chatFont: 'serif' | 'sans' | 'mono'; motion: 'system' | 'reduced'; compact: boolean }): void {
  const root = document.documentElement
  root.dataset.chatFont = a.chatFont
  root.dataset.motion = a.motion
  root.dataset.compact = a.compact ? '1' : '0'
  void api.window.setZoom(a.uiScale).catch(() => undefined)
}

/** Converts any CSS color (hex, rgb(a), color-mix…) used by a theme into #rrggbb(aa) for Monaco. */
const cvs = typeof document !== 'undefined' ? document.createElement('canvas') : null
const ctx2d = cvs?.getContext('2d', { willReadFrequently: true }) ?? null
export function toHex(css: string, fallback = '#000000'): string {
  if (!ctx2d) return fallback
  try {
    ctx2d.clearRect(0, 0, 1, 1)
    ctx2d.fillStyle = '#000'
    ctx2d.fillStyle = css
    ctx2d.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx2d.getImageData(0, 0, 1, 1).data
    const h = (n: number) => n.toString(16).padStart(2, '0')
    return `#${h(r)}${h(g)}${h(b)}${a < 255 ? h(a) : ''}`
  } catch { return fallback }
}
