# Extending TGGAGS IDE

Everything below is plain files — no build step.

## Slash commands

A Markdown file in `.tgg/commands/` (project) or the app's `commands` folder (global). The file name is the command name:

```markdown
---
description: Write a changelog entry
agent: build
---
Write a changelog entry for $ARGUMENTS based on the recent commits.
```

Type `/changelog 1.2.0` in the chat. `.claude/commands/` is read as well.

## Skills

A folder with a `SKILL.md` in `.tgg/skills/<name>/`:

```markdown
---
name: release-notes
description: Use when writing release notes from git history
---
1. Run `git log` since the last tag …
```

The agent sees the list of skills and loads the matching one with the `skill` tool.

## Custom agents

`.tgg/agents/<id>.md` (project) or the app's `agents` folder:

```markdown
---
name: Migrator
description: Plans and performs framework migrations
mode: subagent        # primary | subagent | all
model: anthropic/claude-sonnet-5-5
temperature: 0.2
tools: read, grep, glob, edit, shell   # comma list, or `*`; prefix a name with ! to remove it
permissions:          # tool → action, or tool → { pattern: action }
  edit: ask
  shell:
    "npm test*": allow
    "git push*": deny
---
You are a careful migration engineer …
```

They also appear in *Agents*; hand work over with `@migrator`.

## MCP servers

*Extensions → MCP → Add server* (or `mcp.servers` in settings / `.tgg/settings.json`):

```json
{ "mcp": { "servers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "docs": { "type": "http", "url": "https://example.com/mcp" }
} } }
```

Tools show up as `mcp__<server>__<tool>`, are covered by the `mcp` permission category and can be allowed per tool pattern.

## Hooks

*Settings → Hooks*. Events: `session.start`, `message.before`, `tool.before`, `tool.after`, `file.edited`, `turn.end`, `error`. The command gets a JSON payload on standard input (`event`, `tool`, `input`, `output`, `path`, `cwd`, `sessionId`, `agent`) and `TGG_HOOK_EVENT` in the environment. A *blocking* hook that exits non-zero stops the action and its output is shown to the agent.

## Extensions

A folder with a `tgg-extension.json` manifest, installed from *Extensions → Installed* (folder, `.zip` or URL) or dropped into the `extensions` folder of the app data directory.

```json
{
  "id": "my-extension", "name": "My extension", "version": "1.0.0", "main": "index.js",
  "permissions": ["workspace"],
  "contributes": {
    "commands": [{ "name": "hello", "description": "Greet", "template": "Greet $ARGUMENTS" }],
    "tools": [{ "name": "lint", "description": "Run the linter", "command": "npm run lint -- {{path}}",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } } } }],
    "themes": [{ "id": "my-dark", "name": "My Dark", "kind": "dark", "base": "tgg-dark", "ui": { "--accent": "#7aa2f7" } }],
    "mcpServers": { "example": { "command": "node", "args": ["server.js"] } }
  }
}
```

`main` may export `activate(tgg)` to register tools in JavaScript (see `extensions/hello-tools/index.js`):

```js
exports.activate = tgg => {
  tgg.tools.register({ name: 'word_count', description: '…', parameters: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: true, async execute(args) { return String(await tgg.workspace.readFile(args.path)).split(/\s+/).length } })
  tgg.hooks.on('file.edited', p => tgg.log.info(p.path))
}
```

Extension tools are named `<extension-id>__<tool>` and always start under the `plugin` permission (ask by default). Command-template tools quote every argument for the shell.

## Keybindings & themes

Shortcuts: *Settings → Keyboard shortcuts*, or `keybindings` in the settings file (`{"ai.newChat": "Mod+Alt+N"}`). Themes: extensions can contribute colour themes (see `extensions/theme-pack`).
