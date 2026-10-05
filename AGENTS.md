# AGENTS.md — working on TGGAGS IDE

Electron + React + TypeScript. Main process in `electron/`, renderer in `src/`, shared contracts in `shared/`.

## Commands

```bash
npm ci
npm run dev           # Vite + Electron with reload
npm run build         # renderer → dist/, main → dist-electron/
npm run typecheck     # tsc for renderer and node projects — must pass
npm test              # vitest (needs `npm run build:main` once for the LSP test)
xvfb-run -a node tests/e2e/smoke.mjs                       # boots the built app headlessly
xvfb-run -a node tests/e2e/chat-demo.mjs /tmp/out          # full agent run against a mock model + screenshots
xvfb-run -a node tests/e2e/tour.mjs /tmp/tour              # screenshots of every view
npm run installer:win # Windows installer (release/TGGAGS-IDE-Setup.exe), needs makensis
```

## Conventions

* Add an RPC by extending the interface in `shared/api.ts`, implementing it in `electron/` and wiring it in `electron/api.ts`. The renderer calls it as `api.<domain>.<method>()` — no new IPC channels.
* Renderer state lives in zustand stores (`src/stores`); features are folders under `src/features`. Reuse `src/components/ui.tsx` (Button, Popover, Menu, dialogs, toasts) and the CSS tokens in `src/styles/base.css` — never hard-code colours, use `var(--…)` so all themes work.
* Keyboard shortcuts are matched by `event.code`, so they work on any layout. Register commands in `src/commands/index.ts`.
* Tool arguments coming from a model are untrusted: validate (zod/JSON schema), never "repair" truncated JSON, never build shell strings from them without quoting.
* New agent tools go through `electron/ai/tools/registry.ts` and must declare a permission category, `describe()` (what it touches) and a timeout.
* Secrets never go into settings; use `credentials`.
* Keep comments for the *why*. Tests for behaviour live in `tests/unit` (the agent loop is tested end to end against `helpers/mock-openai.ts`).
