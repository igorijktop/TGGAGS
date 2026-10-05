import { File, FileCode, FileImage, FileText, Folder, FolderOpen, Braces, Package, GitBranch, Lock, Terminal, Settings2, Database, FileArchive, Film, Music, Cog, Shield } from 'lucide-react'
import { extname, basename } from './util'

interface Badge { text: string; bg: string; fg?: string }
const B = (text: string, bg: string, fg = '#fff'): Badge => ({ text, bg, fg })

const BY_EXT: Record<string, Badge> = {
  ts: B('TS', '#3178C6'), tsx: B('TX', '#3178C6'), mts: B('TS', '#3178C6'), cts: B('TS', '#3178C6'), js: B('JS', '#E8C410', '#2b2400'), jsx: B('JX', '#E8C410', '#2b2400'), mjs: B('JS', '#E8C410', '#2b2400'), cjs: B('JS', '#E8C410', '#2b2400'),
  py: B('PY', '#3776AB'), go: B('GO', '#00ADD8'), rs: B('RS', '#C9622B'), java: B('JV', '#D0572B'), kt: B('KT', '#8B5CF6'), cs: B('C#', '#6A3FA0'), cpp: B('C+', '#00599C'), cc: B('C+', '#00599C'), c: B('C', '#5A6FA8'), h: B('H', '#5A6FA8'), hpp: B('H+', '#00599C'),
  rb: B('RB', '#CC342D'), php: B('PH', '#777BB4'), swift: B('SW', '#F05138'), lua: B('LU', '#000080'), luau: B('LU', '#000080'), dart: B('DA', '#0175C2'), sh: B('SH', '#4EAA25'), bash: B('SH', '#4EAA25'), ps1: B('PS', '#2671BE'), bat: B('BT', '#5A5A5A'), cmd: B('BT', '#5A5A5A'),
  html: B('HT', '#E34F26'), htm: B('HT', '#E34F26'), css: B('CS', '#7C4DDB'), scss: B('SC', '#CC6699'), less: B('LS', '#1D365D'), vue: B('VU', '#42B883'), svelte: B('SV', '#FF3E00'),
  json: B('{}', '#C99700'), jsonc: B('{}', '#C99700'), yml: B('YM', '#CB171E'), yaml: B('YM', '#CB171E'), toml: B('TM', '#9C4221'), xml: B('XM', '#E37933'), md: B('MD', '#4A90D9'), mdx: B('MX', '#F9AC00'), sql: B('SQ', '#E48E00'), graphql: B('GQ', '#E10098'), env: B('EV', '#6B8E23'),
  lock: B('LK', '#7A7A7A'), txt: B('TX', '#7A7A7A'), log: B('LG', '#7A7A7A'), csv: B('CS', '#1D7A46'), svg: B('SG', '#E58A00'), nsi: B('NS', '#5A6FA8'), dockerfile: B('DK', '#2496ED'), tf: B('TF', '#7B42BC'), proto: B('PB', '#4A90D9')
}
const BY_NAME: Record<string, Badge> = {
  'package.json': B('NP', '#CB3837'), 'package-lock.json': B('NP', '#8A8A8A'), 'tsconfig.json': B('TS', '#3178C6'), dockerfile: B('DK', '#2496ED'), '.gitignore': B('GI', '#F05133'), '.gitattributes': B('GI', '#F05133'),
  'readme.md': B('RM', '#4A90D9'), license: B('LI', '#C49A00'), makefile: B('MK', '#6D8086'), 'cargo.toml': B('CG', '#C9622B'), 'go.mod': B('GO', '#00ADD8'), 'requirements.txt': B('PY', '#3776AB'), 'agents.md': B('AI', '#C4623F'), 'claude.md': B('AI', '#C4623F'), '.env': B('EV', '#6B8E23')
}
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

export function FileIcon({ name, dir, open, size = 16 }: { name: string; dir?: boolean; open?: boolean; size?: number }) {
  if (dir) { const I = open ? FolderOpen : Folder; return <I size={size} strokeWidth={1.7} style={{ color: 'var(--accent)' }} fill="color-mix(in srgb, var(--accent) 14%, transparent)" /> }
  const lower = name.toLowerCase()
  const ext = extname(name)
  const badge = BY_NAME[lower] ?? (lower.startsWith('.env') ? BY_EXT.env : undefined) ?? BY_EXT[ext]
  if (badge) return <span className="file-badge" style={{ background: badge.bg, color: badge.fg, width: size, height: size, fontSize: size * 0.5 }}>{badge.text}</span>
  if (IMG.has(ext)) return <FileImage size={size} strokeWidth={1.7} style={{ color: '#2F9E6B' }} />
  if (['mp4', 'webm', 'mov'].includes(ext)) return <Film size={size} strokeWidth={1.7} style={{ color: '#9C5BD6' }} />
  if (['mp3', 'wav', 'ogg'].includes(ext)) return <Music size={size} strokeWidth={1.7} style={{ color: '#D6518C' }} />
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return <FileArchive size={size} strokeWidth={1.7} style={{ color: '#B08A3E' }} />
  if (['exe', 'dll', 'so', 'bin'].includes(ext)) return <Cog size={size} strokeWidth={1.7} style={{ color: '#7A7A7A' }} />
  return <File size={size} strokeWidth={1.6} style={{ color: 'var(--fg-subtle)' }} />
}

export { FileCode, FileText, Braces, Package, GitBranch, Lock, Terminal, Settings2, Database, Shield, basename }
