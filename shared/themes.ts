// Built-in color themes. Every theme is a flat map of CSS variables + a syntax palette.
// The renderer applies `ui` as CSS custom properties and derives the Monaco theme from the same values.

export interface SyntaxPalette {
  comment: string; keyword: string; string: string; number: string; type: string; function: string
  variable: string; constant: string; operator: string; tag: string; attribute: string; regexp: string; punctuation: string
}

export interface ThemeDef {
  id: string
  name: string
  kind: 'light' | 'dark'
  description?: string
  ui: Record<string, string>
  syntax: SyntaxPalette
  /** extra Monaco color overrides */
  monaco?: Record<string, string>
}

interface Palette {
  bg: string; sidebar: string; elevated: string; hover: string; active: string; input: string
  fg: string; muted: string; subtle: string; border: string; borderStrong: string
  accent: string; accentStrong: string; accentFg: string; accentSoft: string
  success: string; warning: string; danger: string; info: string
  selection: string; shadow: string; overlay: string
}

function make(id: string, name: string, kind: 'light' | 'dark', p: Palette, syntax: SyntaxPalette, description?: string, monaco?: Record<string, string>): ThemeDef {
  const soft = (name: string) => `color-mix(in srgb, var(--${name}) ${kind === 'light' ? 12 : 18}%, transparent)`
  return {
    id, name, kind, description, syntax, monaco,
    ui: {
      '--bg': p.bg, '--bg-sidebar': p.sidebar, '--bg-elevated': p.elevated, '--bg-hover': p.hover, '--bg-active': p.active, '--bg-input': p.input,
      '--fg': p.fg, '--fg-muted': p.muted, '--fg-subtle': p.subtle, '--border': p.border, '--border-strong': p.borderStrong,
      '--accent': p.accent, '--accent-strong': p.accentStrong, '--accent-fg': p.accentFg, '--accent-soft': p.accentSoft,
      '--success': p.success, '--warning': p.warning, '--danger': p.danger, '--info': p.info,
      '--success-soft': soft('success'), '--warning-soft': soft('warning'), '--danger-soft': soft('danger'), '--info-soft': soft('info'),
      '--selection': p.selection, '--shadow-color': p.shadow, '--overlay': p.overlay,
      '--diff-add': soft('success'), '--diff-del': soft('danger')
    }
  }
}

const paperSyntax: SyntaxPalette = {
  comment: '#8C8777', keyword: '#A8432F', string: '#44773A', number: '#B2641B', type: '#1C6B86', function: '#5846B0', variable: '#2A2925',
  constant: '#B2641B', operator: '#6A675E', tag: '#A8432F', attribute: '#B2641B', regexp: '#A8432F', punctuation: '#77746A'
}
const daylightSyntax: SyntaxPalette = {
  comment: '#7F8896', keyword: '#8A3FC0', string: '#18794E', number: '#B25E09', type: '#0B6E99', function: '#2457C5', variable: '#1F2430',
  constant: '#B25E09', operator: '#5B6475', tag: '#C0392B', attribute: '#B25E09', regexp: '#C0392B', punctuation: '#6B7385'
}
const charcoalSyntax: SyntaxPalette = {
  comment: '#827E73', keyword: '#E6897A', string: '#A9C987', number: '#E8A768', type: '#7EC4DA', function: '#B8A9F5', variable: '#ECE9DF',
  constant: '#E8A768', operator: '#A9A59A', tag: '#E6897A', attribute: '#E8A768', regexp: '#E6897A', punctuation: '#A19D92'
}
const midnightSyntax: SyntaxPalette = {
  comment: '#6C7A96', keyword: '#C792EA', string: '#A3D988', number: '#F6A96B', type: '#6FD1E8', function: '#82AAFF', variable: '#D6DEEB',
  constant: '#F6A96B', operator: '#89A0C8', tag: '#FF7B8F', attribute: '#F6A96B', regexp: '#FF7B8F', punctuation: '#8394B3'
}
const contrastSyntax: SyntaxPalette = {
  comment: '#9AA0A6', keyword: '#FF9D7E', string: '#B6F28C', number: '#FFD27D', type: '#7FE3FF', function: '#C6B5FF', variable: '#FFFFFF',
  constant: '#FFD27D', operator: '#E5E5E5', tag: '#FF9D7E', attribute: '#FFD27D', regexp: '#FF9D7E', punctuation: '#E0E0E0'
}

export const THEMES: ThemeDef[] = [
  make('tgg-light', 'Paper', 'light', {
    bg: '#FCFBF8', sidebar: '#F6F4EF', elevated: '#FFFFFF', hover: '#EFECE5', active: '#E8E4DB', input: '#FFFFFF',
    fg: '#1F1E1B', muted: '#68655D', subtle: '#96928A', border: '#E7E3DA', borderStrong: '#D6D1C5',
    accent: '#C4623F', accentStrong: '#B05230', accentFg: '#FFFFFF', accentSoft: 'rgba(196,98,63,0.11)',
    success: '#2F7D4F', warning: '#B26B00', danger: '#C23B31', info: '#2563A8', selection: 'rgba(196,98,63,0.20)', shadow: '60,45,25', overlay: 'rgba(31,30,27,0.38)'
  }, paperSyntax, 'Warm, calm and easy on the eyes. The default.'),
  make('tgg-daylight', 'Daylight', 'light', {
    bg: '#FFFFFF', sidebar: '#F4F6F9', elevated: '#FFFFFF', hover: '#EAEEF4', active: '#DFE5EE', input: '#FFFFFF',
    fg: '#1B2230', muted: '#586174', subtle: '#8A93A5', border: '#E2E7EF', borderStrong: '#CBD3E0',
    accent: '#2F6FEB', accentStrong: '#2459C7', accentFg: '#FFFFFF', accentSoft: 'rgba(47,111,235,0.10)',
    success: '#1E8A55', warning: '#B76E00', danger: '#D13B3B', info: '#2F6FEB', selection: 'rgba(47,111,235,0.20)', shadow: '30,50,90', overlay: 'rgba(20,28,45,0.40)'
  }, daylightSyntax, 'Crisp neutral light theme with a blue accent.'),
  make('tgg-dark', 'Charcoal', 'dark', {
    bg: '#262624', sidebar: '#1F1E1D', elevated: '#30302D', hover: '#2D2C2A', active: '#383733', input: '#2E2D2B',
    fg: '#F2F0E9', muted: '#B0ACA1', subtle: '#827E73', border: '#3A3935', borderStrong: '#4A4842',
    accent: '#E0805D', accentStrong: '#B85A3A', accentFg: '#FFFFFF', accentSoft: 'rgba(224,128,93,0.16)',
    success: '#6FC28B', warning: '#E3A93E', danger: '#F0776D', info: '#7AAEF0', selection: 'rgba(224,128,93,0.28)', shadow: '0,0,0', overlay: 'rgba(0,0,0,0.55)'
  }, charcoalSyntax, 'Warm dark theme matching the Paper light theme.'),
  make('tgg-midnight', 'Midnight', 'dark', {
    bg: '#0F1624', sidebar: '#0B111C', elevated: '#18223A', hover: '#17213A', active: '#1F2B49', input: '#141D31',
    fg: '#E4EAF6', muted: '#9AA8C4', subtle: '#69789A', border: '#202C47', borderStrong: '#2C3B5E',
    accent: '#6EA8FF', accentStrong: '#4E8BEA', accentFg: '#0B111C', accentSoft: 'rgba(110,168,255,0.16)',
    success: '#62D394', warning: '#F2B84B', danger: '#FF7B8F', info: '#6EA8FF', selection: 'rgba(110,168,255,0.28)', shadow: '0,0,0', overlay: 'rgba(3,6,14,0.62)'
  }, midnightSyntax, 'Deep blue dark theme.'),
  make('tgg-contrast', 'High Contrast', 'dark', {
    bg: '#000000', sidebar: '#0A0A0A', elevated: '#141414', hover: '#1F1F1F', active: '#2B2B2B', input: '#0A0A0A',
    fg: '#FFFFFF', muted: '#D4D4D4', subtle: '#A8A8A8', border: '#6B6B6B', borderStrong: '#9A9A9A',
    accent: '#FFB86B', accentStrong: '#FFA040', accentFg: '#000000', accentSoft: 'rgba(255,184,107,0.22)',
    success: '#7CFFA8', warning: '#FFD866', danger: '#FF8A80', info: '#82CFFF', selection: 'rgba(255,184,107,0.38)', shadow: '0,0,0', overlay: 'rgba(0,0,0,0.75)'
  }, contrastSyntax, 'Maximum legibility.')
]

export function themeById(id: string): ThemeDef {
  return THEMES.find(t => t.id === id) ?? THEMES[0]
}
