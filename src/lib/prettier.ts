import { api } from './api'
import { getSettings } from '../stores/settings'

const PARSERS: Record<string, string> = { typescript: 'typescript', javascript: 'babel', json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', markdown: 'markdown', yaml: 'yaml' }
export const prettierLanguages = Object.keys(PARSERS)

let loaded: Promise<{ format: (src: string, opts: Record<string, unknown>) => Promise<string>; plugins: unknown[] }> | null = null
function load() {
  loaded ??= Promise.all([import('prettier/standalone'), import('prettier/plugins/babel'), import('prettier/plugins/estree'), import('prettier/plugins/typescript'), import('prettier/plugins/postcss'), import('prettier/plugins/html'), import('prettier/plugins/markdown'), import('prettier/plugins/yaml')])
    .then(([std, ...plugins]) => ({ format: std.format as never, plugins: plugins.map(p => (p as { default?: unknown }).default ?? p) }))
  return loaded
}

/** Formats text with Prettier (JS/TS/JSON/CSS/HTML/Markdown/YAML) or a configured external formatter. Returns null when nothing applies. */
export async function formatDocumentText(path: string, text: string, languageId: string): Promise<string | null> {
  const ed = getSettings().editor
  const parser = PARSERS[languageId]
  if (parser) {
    try {
      const { format, plugins } = await load()
      return await format(text, { parser: /\.tsx?$/.test(path) || languageId !== 'javascript' ? parser : 'babel', plugins, tabWidth: ed.tabSize, useTabs: !ed.insertSpaces, semi: !/\.(json)$/.test(path), singleQuote: true, printWidth: 100, trailingComma: 'es5' })
    } catch (e) { throw new Error(`Prettier: ${(e as Error).message.split('\n')[0]}`) }
  }
  return api.lsp.externalFormat(path, text, languageId)
}
