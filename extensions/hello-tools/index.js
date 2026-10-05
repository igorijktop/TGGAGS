// Example TGGAGS IDE extension. It runs in the IDE's main process (Node.js) and may use any Node API.
// Tools registered here appear to the AI agent as `hello-tools__<name>` and always ask for permission first.
const crypto = require('node:crypto')

exports.activate = function activate(tgg) {
  tgg.log.info('Hello Tools activated')

  tgg.tools.register({
    name: 'word_count',
    description: 'Count the lines, words and characters of a text file in the project.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the project' } }, required: ['path'] },
    readOnly: true,
    async execute(args) {
      const text = await tgg.workspace.readFile(args.path)
      return `${args.path}: ${text.split('\n').length} lines, ${text.split(/\s+/).filter(Boolean).length} words, ${text.length} characters`
    }
  })

  tgg.tools.register({
    name: 'uuid',
    description: 'Generate one or more random UUIDs.',
    parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 20 } } },
    readOnly: true,
    async execute(args) { return Array.from({ length: args.count || 1 }, () => crypto.randomUUID()).join('\n') }
  })

  tgg.tools.register({
    name: 'slugify',
    description: 'Convert text into a URL-friendly slug.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    readOnly: true,
    async execute(args) { return String(args.text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-') }
  })

  tgg.hooks.on('file.edited', payload => { tgg.log.info('agent edited ' + payload.path) })
}
