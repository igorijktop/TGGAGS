// Extension / filename → language id (Monaco-compatible ids). Used by both processes.

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', html: 'html', htm: 'html', vue: 'html', svelte: 'html', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', py: 'python', pyw: 'python', pyi: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', fs: 'fsharp', lua: 'lua', luau: 'lua',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  cfg: 'ini', conf: 'ini', env: 'ini', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', sql: 'sql', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile',
  r: 'r', dart: 'dart', scala: 'scala', ex: 'elixir', exs: 'elixir', clj: 'clojure', hs: 'haskell', pl: 'perl', tf: 'hcl', hcl: 'hcl', proto: 'protobuf', sol: 'sol',
  txt: 'plaintext', log: 'plaintext', csv: 'plaintext', gitignore: 'ignore', nsi: 'plaintext', diff: 'plaintext', patch: 'plaintext'
}

const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', '.gitignore': 'ignore', '.dockerignore': 'ignore', '.env': 'ini',
  '.editorconfig': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', 'tsconfig.json': 'json', 'package.json': 'json', gemfile: 'ruby', rakefile: 'ruby'
}

export function languageForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const lower = base.toLowerCase()
  if (NAMES[lower]) return NAMES[lower]
  if (lower.startsWith('.env')) return 'ini'
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return EXT[lower.slice(dot + 1)] ?? 'plaintext'
}

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'])
export const MEDIA_EXT = new Set([...IMAGE_EXT, 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'pdf'])
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i < 0 ? '' : base.slice(i + 1).toLowerCase()
}
export function isImagePath(path: string): boolean { return IMAGE_EXT.has(extOf(path)) }
export function mimeForPath(path: string): string {
  const e = extOf(path)
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
    avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf'
  }
  return map[e] ?? 'application/octet-stream'
}
