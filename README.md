<div align="center">

# TGGAGS IDE

**An AI-powered code editor that lives on your computer.**
Editor · coding agents · terminal · Git · debugger · MCP · image studio — in one calm, readable window.

[**Download the Windows installer**](release/TGGAGS-IDE-Setup.exe) · [User guide](docs/USER-GUIDE.md) · [Extending](docs/EXTENDING.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

## Install (Windows)

1. Download **`release/TGGAGS-IDE-Setup.exe`** from this repository (or from the *Releases* page).
2. Double-click it. The installer wizard starts — **no internet connection is needed**, neither to install nor to run the editor itself.
3. Start **TGGAGS IDE** from the Start menu or the desktop. A short welcome guide helps you pick a theme and connect an AI model.

The installer is per-user (no administrator rights needed), supports English and Russian, can add an *“Open with TGGAGS IDE”* entry to the Explorer context menu, and uninstalls cleanly from *Settings → Apps*.

> **Windows SmartScreen:** the installer is not code-signed (certificates cost money). If Windows says *“Windows protected your PC”*, choose **More info → Run anyway**. You can verify the download with `TGGAGS-IDE-Setup.exe.sha256`.

You only need internet access for the things that are online by nature: talking to a cloud AI provider, web search/fetch tools, GitHub. With a local model (Ollama, LM Studio, llama.cpp, Stable Diffusion WebUI) everything works fully offline.

## What you get

| | |
|---|---|
| **Editor** | Monaco-based editor with tabs, split views, pinned & preview tabs, breadcrumbs, minimap, folding, multi-cursor, diff view, themes (5 built in + 5 more through an extension), format on save (Prettier for web languages), auto-save, per-file language servers |
| **AI agent** | Streaming chat with live tool cards, reasoning blocks, undo per turn, file-change review, todo lists, sub-agents, context meter (*“18,442 / 128,000 tokens”*), compaction, session history, fork / edit / retry |
| **Agents** | **Build** (edits & runs) and **Plan** (read-only) plus specialists — General, Explore, Reviewer, Debugger, Tester, Researcher, Designer, Security, Docs — and your own custom agents (prompt, model, tools, permissions, temperature). Type `@name` to hand work to one. |
| **Tools** | `read` `list` `glob` `grep` `edit` `write` `apply_patch` `shell` `webfetch` `websearch` `lsp` `todowrite` `todoread` `question` `skill` `subagent` `memory` `generate_image` `github` — plus MCP servers, extension tools and custom command tools |
| **Permissions** | Granular allow / ask / deny rules by tool, path, command, domain and agent. Four modes: *Ask*, *Auto* (auto-accept project edits), *Plan*, *Bypass*. A clear approval sheet with diff / command preview and *Allow once · for this chat · always* |
| **Models** | Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Ollama, LM Studio, llama.cpp and any OpenAI- or Anthropic-compatible endpoint. Smart routing, fallbacks, role models, a benchmark page |
| **Images** | Image studio: generate, edit with a painted mask, variations, upscale, describe, read text (OCR), asset library — OpenAI, Gemini/Imagen, Stability, local Stable Diffusion |
| **Source control** | Stage / unstage / discard, commit (with AI-written messages), branches, merge, rebase, cherry-pick, revert, stash, history, conflict helpers, GitHub pull requests, issues and Actions |
| **Run & debug** | Launch configurations, breakpoints (conditions), variables, watch, call stack, debug console, step controls — for Node.js. Project scripts, test runner, dependency manager, deploy helpers |
| **Terminal** | Real PTY terminals (xterm.js), several at once, restore on tab switch |
| **Extensibility** | Extensions (tools, commands, themes, MCP servers, keybindings), MCP client (stdio & HTTP), skills, slash commands, hooks, custom agents as Markdown files |
| **Safety** | Secrets are redacted before they reach a model, `.env` files are never read by default, destructive commands are blocked, API keys are stored in the OS secure storage |

## Using it

1. **Connect a model** — *Models* in the left bar → *Add provider*, paste a key (or choose a local server).
2. **Open a folder** — *File → Open Folder* (or drop it on the window).
3. **Ask** — type in the message box on the right. `@` adds files, `/` runs commands, the **+** button attaches the open file, selection, terminal output, problems or a web page.
4. **Review** — edits appear as diffs in the chat. *Undo* reverts a turn, *Review* opens every changed file, *Keep* accepts.

Useful shortcuts (all can be changed in *Settings → Keyboard shortcuts*; they work on any keyboard layout):

| Action | Shortcut |
|---|---|
| Command palette | `Ctrl+Shift+P` |
| Go to file | `Ctrl+P` |
| New chat | `Ctrl+Shift+N` |
| Focus the message box · maximise chat | `Ctrl+I` · `Ctrl+Alt+C` |
| Toggle terminal | ``Ctrl+` `` |
| Find in files | `Ctrl+Shift+F` |
| Start / continue debugging | `F5` |
| Toggle breakpoint | `F9` |

## Build from source

Requirements: **Node.js 22+** (24 recommended) and Git.

```bash
npm ci
npm run dev            # Vite dev server + Electron with hot reload
npm run build          # production build (renderer → dist/, main → dist-electron/)
npm run typecheck
npm test               # unit tests (agent loop, tools, permissions, providers, Git, LSP, debugger, MCP …)
npm run package:win    # Windows app folder in build-win/pkg  (works on Linux, macOS and Windows)
npm run installer:win  # + the NSIS installer → release/TGGAGS-IDE-Setup.exe   (needs `makensis`)
```

The Windows packaging script downloads the official Electron runtime once (cached in `build-win/cache`), packs the app into `app.asar`, brands `TGGAGS IDE.exe` (icon, version info) and compiles `scripts/installer.nsi`. The GitHub workflow **Build Windows installer** does the same on a `windows-latest` runner (run it from the *Actions* tab, or push a `v*` tag to also publish a release).

## Project layout

```
electron/   main process: window, RPC, services (settings, fs, search, terminal, git, lsp, debug …),
            ai/ (agent runtime, providers, tools, permissions, context, sessions, snapshots, router, hooks),
            ext/ (MCP, extensions), media/ (images), integrations/ (GitHub)
shared/     types & contracts shared by both processes (typed RPC surface in api.ts, settings, themes, presets)
src/        renderer (React 19): design system, shell, editor, chat, settings, pages, panels
extensions/ bundled example extensions
scripts/    build, dev, icon and Windows packaging scripts
tests/      unit tests (vitest) and Electron end-to-end scripts (Playwright)
docs/       guides
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Honest limits

* The debugger supports **Node.js** (including TypeScript/JavaScript run by Node). Other languages get language-server support (when the server is installed) and the terminal, but no breakpoint debugging.
* Language servers for Python, Go, Rust and C/C++ are **not bundled** — install `pyright`, `gopls`, `rust-analyzer` or `clangd` and they are picked up. TypeScript/JavaScript intelligence is built in.
* The installer is **unsigned**, and it is built and verified on Linux plus a static check of the produced Windows files; the CI workflow builds it on Windows as well.
* AI features need a provider you configure; there is no hosted backend and no telemetry.

## License

MIT
