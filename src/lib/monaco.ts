// Monaco editor bootstrap: workers, languages and themes. Everything is bundled locally – no CDN.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker'
import type { ThemeDef } from '@shared/themes'
import { toHex } from './theme'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    return new EditorWorker()
  }
}

export { monaco }

export const monacoThemeName = (t: ThemeDef) => `tgg-${t.id}`

export function defineMonacoTheme(t: ThemeDef): string {
  const name = monacoThemeName(t)
  const u = t.ui, s = t.syntax
  const c = (v: string) => toHex(v)
  const hex = (v: string) => c(v).replace('#', '')
  const dark = t.kind === 'dark'
  const bg = c(u['--bg'])
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs', inherit: true,
    rules: [
      { token: '', foreground: hex(s.variable) },
      { token: 'comment', foreground: hex(s.comment), fontStyle: 'italic' }, { token: 'comment.doc', foreground: hex(s.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex(s.keyword) }, { token: 'keyword.control', foreground: hex(s.keyword) }, { token: 'keyword.operator', foreground: hex(s.operator) },
      { token: 'string', foreground: hex(s.string) }, { token: 'string.escape', foreground: hex(s.regexp) }, { token: 'string.key.json', foreground: hex(s.attribute) }, { token: 'string.value.json', foreground: hex(s.string) },
      { token: 'number', foreground: hex(s.number) }, { token: 'number.float', foreground: hex(s.number) }, { token: 'number.hex', foreground: hex(s.number) },
      { token: 'type', foreground: hex(s.type) }, { token: 'type.identifier', foreground: hex(s.type) }, { token: 'namespace', foreground: hex(s.type) },
      { token: 'identifier', foreground: hex(s.variable) }, { token: 'variable', foreground: hex(s.variable) }, { token: 'variable.predefined', foreground: hex(s.constant) },
      { token: 'constant', foreground: hex(s.constant) }, { token: 'predefined', foreground: hex(s.function) }, { token: 'function', foreground: hex(s.function) },
      { token: 'operator', foreground: hex(s.operator) }, { token: 'delimiter', foreground: hex(s.punctuation) }, { token: 'delimiter.bracket', foreground: hex(s.punctuation) },
      { token: 'tag', foreground: hex(s.tag) }, { token: 'metatag', foreground: hex(s.tag) }, { token: 'attribute.name', foreground: hex(s.attribute) }, { token: 'attribute.value', foreground: hex(s.string) },
      { token: 'regexp', foreground: hex(s.regexp) }, { token: 'annotation', foreground: hex(s.function) }, { token: 'invalid', foreground: hex(u['--danger']) },
      { token: 'markup.heading', foreground: hex(s.keyword), fontStyle: 'bold' }, { token: 'markup.bold', fontStyle: 'bold' }, { token: 'markup.italic', fontStyle: 'italic' }, { token: 'markup.inline.raw', foreground: hex(s.string) }
    ],
    colors: {
      'editor.background': bg, 'editor.foreground': c(u['--fg']),
      'editorLineNumber.foreground': c(u['--fg-subtle']), 'editorLineNumber.activeForeground': c(u['--fg-muted']),
      'editor.selectionBackground': c(u['--selection']), 'editor.inactiveSelectionBackground': toHex(`color-mix(in srgb, ${u['--selection']} 60%, transparent)`),
      'editor.selectionHighlightBackground': toHex(`color-mix(in srgb, ${u['--accent']} 14%, transparent)`),
      'editor.wordHighlightBackground': toHex(`color-mix(in srgb, ${u['--accent']} 14%, transparent)`), 'editor.findMatchBackground': toHex(`color-mix(in srgb, ${u['--warning']} 40%, transparent)`),
      'editor.findMatchHighlightBackground': toHex(`color-mix(in srgb, ${u['--warning']} 22%, transparent)`),
      'editor.lineHighlightBackground': toHex(`color-mix(in srgb, ${u['--fg']} ${dark ? 5 : 3.5}%, transparent)`), 'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': c(u['--accent']), 'editorWhitespace.foreground': toHex(`color-mix(in srgb, ${u['--fg']} 14%, transparent)`),
      'editorIndentGuide.background1': toHex(`color-mix(in srgb, ${u['--fg']} 9%, transparent)`), 'editorIndentGuide.activeBackground1': toHex(`color-mix(in srgb, ${u['--fg']} 22%, transparent)`),
      'editorBracketMatch.background': toHex(`color-mix(in srgb, ${u['--accent']} 18%, transparent)`), 'editorBracketMatch.border': c(u['--accent']),
      'editorGutter.background': bg, 'editorOverviewRuler.border': '#00000000',
      'editorWidget.background': c(u['--bg-elevated']), 'editorWidget.border': c(u['--border-strong']), 'editorWidget.foreground': c(u['--fg']),
      'editorSuggestWidget.background': c(u['--bg-elevated']), 'editorSuggestWidget.border': c(u['--border-strong']), 'editorSuggestWidget.selectedBackground': c(u['--bg-active']), 'editorSuggestWidget.highlightForeground': c(u['--accent-strong']),
      'editorHoverWidget.background': c(u['--bg-elevated']), 'editorHoverWidget.border': c(u['--border-strong']),
      'input.background': c(u['--bg-input']), 'input.border': c(u['--border-strong']), 'inputOption.activeBorder': c(u['--accent']), 'focusBorder': c(u['--accent']),
      'list.hoverBackground': c(u['--bg-hover']), 'list.activeSelectionBackground': c(u['--bg-active']), 'list.focusBackground': c(u['--bg-active']),
      'scrollbarSlider.background': toHex(`color-mix(in srgb, ${u['--fg']} 14%, transparent)`), 'scrollbarSlider.hoverBackground': toHex(`color-mix(in srgb, ${u['--fg']} 26%, transparent)`), 'scrollbarSlider.activeBackground': toHex(`color-mix(in srgb, ${u['--fg']} 34%, transparent)`),
      'minimap.background': c(u['--bg']), 'minimapSlider.background': toHex(`color-mix(in srgb, ${u['--fg']} 10%, transparent)`),
      'editorError.foreground': c(u['--danger']), 'editorWarning.foreground': c(u['--warning']), 'editorInfo.foreground': c(u['--info']),
      'diffEditor.insertedTextBackground': toHex(`color-mix(in srgb, ${u['--success']} 22%, transparent)`), 'diffEditor.insertedLineBackground': toHex(`color-mix(in srgb, ${u['--success']} 11%, transparent)`),
      'diffEditor.removedTextBackground': toHex(`color-mix(in srgb, ${u['--danger']} 22%, transparent)`), 'diffEditor.removedLineBackground': toHex(`color-mix(in srgb, ${u['--danger']} 11%, transparent)`),
      'diffEditor.border': c(u['--border']), 'diffEditorGutter.insertedLineBackground': toHex(`color-mix(in srgb, ${u['--success']} 16%, transparent)`), 'diffEditorGutter.removedLineBackground': toHex(`color-mix(in srgb, ${u['--danger']} 16%, transparent)`),
      'editorStickyScroll.background': c(u['--bg']), 'editorStickyScrollHover.background': c(u['--bg-hover']),
      'peekViewEditor.background': c(u['--bg-sidebar']), 'peekViewResult.background': c(u['--bg-elevated']), 'peekViewTitle.background': c(u['--bg-elevated']), 'peekViewBorder': c(u['--accent']),
      'editorLightBulb.foreground': c(u['--warning']), 'breadcrumb.foreground': c(u['--fg-muted']), 'editorCodeLens.foreground': c(u['--fg-subtle']),
      ...(t.monaco ?? {})
    }
  })
  return name
}

// The IDE ships its own project-aware TypeScript/JavaScript language service (see electron/dev/ts-worker.ts),
// so Monaco's built-in worker-based TS features are switched off to avoid duplicate results.
const disabledFeatures = {
  completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false,
  documentRangeFormattingEdits: false, documentFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false
}
for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  d.setModeConfiguration(disabledFeatures)
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true })
}
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', schemaValidation: 'warning' })
