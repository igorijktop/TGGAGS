# User guide

## First steps

1. **Welcome guide** — pick a theme, connect a model, open a project. You can skip any step and do it later.
2. **Models** (left bar) → **Add provider**. Paste an API key, or choose a *local* provider such as Ollama which needs no key and no internet.
3. **File → Open Folder…** to choose the project the agent works in.

## Talking to the agent

* The conversation happens in the **main window**, in the permanent **Chat** tab (first tab, it cannot be closed). A new chat shows the welcome screen; once you send a message it becomes the full conversation. Files you open get their own tabs next to it — a pulsing dot on the Chat tab tells you the agent is still working or waiting for you. *New chat* (`Ctrl+Shift+N`) starts over; *AI Chats* in the left bar lists earlier ones.
* Want the chat beside a file instead? `Ctrl+Alt+B` opens an optional side chat that shows while a file tab is active.
* Press **Enter** to send, **Shift+Enter** for a new line. While the agent is working, new messages are queued.
* `@` mentions files, folders and agents (`@reviewer please check src/`). `/` lists commands (`/review`, `/fix`, `/test`, `/explain`, `/plan`, `/init`, `/compact`, `/undo`…).
* **+** attaches the current file, the editor selection, terminal output, problems, uncommitted changes or a web page. Paste or drop images to show the model screenshots.
* The **context bar** above the box shows what is attached and how much of the model's window is used. Click an item to pin it, set its priority or remove it. *Compact* summarises older messages.
* **Agent** selector: *Build* can edit files and run commands; *Plan* only reads and proposes.
* **Effort** controls how long a reasoning model thinks (Off … Max).
* **Permissions** selector: *Ask* (confirm everything), *Auto* (project edits are applied automatically), *Plan* (read-only), *Bypass* (no prompts; destructive commands stay blocked).

## Approving actions

When the agent wants to do something that needs approval, a sheet replaces the message box with a preview (diff or command):

| Key | Action |
|---|---|
| `Enter` | Allow once |
| `Shift+Enter` | Allow for this chat |
| `Esc` | Deny |

*Always allow…* turns the request into a permanent rule (editable in *Settings → Permissions*). The pencil lets you deny with a note that is sent back to the agent.

## Reviewing changes

Each assistant turn shows the files it changed. **Undo** reverts that turn; **Review** opens a page with every changed file and a diff; **Keep** accepts. Reverts use snapshots, not Git, so they work in any folder.

## Git

*Source Control* shows staged and unstaged files, a commit box (the ✨ button writes a message from your diff), branches, history and stashes. Right-click commits and branches for merge, rebase, cherry-pick, revert and tags. Conflicts offer *Keep mine / Take theirs / Keep both*.

## Run, test, debug

*Run & Debug* starts the current JavaScript file (or a launch configuration) with or without the debugger. The **Project** tab lists scripts from `package.json`, the test command, dependencies (with an update check) and deploy helpers. Output goes to the terminal or the *Debug console*.

## Images

In *Models → your provider* add models by ID and pick **Text** or **Image** (the type is also guessed from the ID, e.g. `gpt-image-1`); the 🖼 button on a model row switches it to an image model. Image models appear in the studio and in *Default image model*.

*Images* opens the studio: describe a picture, edit one by painting over the part to change, make variations, upscale, describe it or read the text in it. Everything lands in the library.

## Updates

When a newer version exists, a blue **Update** button appears in the title bar. Click it to see what is new, then **Update now**: the installer is downloaded (with progress), its SHA-256 checksum is verified, and the app restarts into the new version — unsaved files are saved first and a running agent task is only stopped after you confirm. *Help → Check for Updates…* checks on demand; *Settings → About* turns the automatic check off. Releases are announced by `release/latest.json` in the repository; maintainers publish one by running `npm run installer:win` (it writes the manifest with the notes from `CHANGELOG.md`) and committing `release/`.

## Settings worth knowing

* **Appearance** — theme, chat font (serif / sans / mono), interface size.
* **AI & agents** — defaults, step limit, retries, automatic compaction, custom instructions.
* **Permissions** — your rules on top of the safe defaults.
* **Context & memory** — files that are never sent, secret hiding, notes the agent remembers.
* **Hooks** — run your own command when something happens (for example `npm test` when the agent finishes).
* **Keyboard shortcuts** — click a shortcut to record a new one.

## Project instructions

Put an `AGENTS.md` in your project to tell the agent how the project works (build/test commands, conventions). `/init` writes a first version for you. `CLAUDE.md` files are read too.
