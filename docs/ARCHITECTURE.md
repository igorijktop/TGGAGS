# Architecture

TGGAGS IDE is an Electron app with a strict split between a privileged **main process** (Node.js) and an unprivileged **renderer** (React).

```
┌───────────────────────────── renderer (React 19, sandboxed) ─────────────────────────────┐
│ shell · editor (Monaco) · chat · settings · pages · panels · zustand stores              │
│ src/lib/api.ts  ── Proxy → window.tgg.rpc(path, args)      onEvent(channel, handler)     │
└──────────────────────────────────────┬───────────────────────────────────────────────────┘
                 contextIsolation + preload (electron/preload.ts): one `rpc` invoke, one event stream
┌──────────────────────────────────────┴───────────────────────────────────────────────────┐
│ main process (electron/)                                                                  │
│  rpc.ts  – resolves "ai.sessions.get" → implementation, wraps errors                      │
│  services/  settings · credentials · workspace/watcher · fs · search · output · proc      │
│  dev/       terminal (node-pty) · git · lsp + ts-worker · debug (CDP) · project info      │
│  ai/        runtime · providers · tools · permissions · context · sessions · snapshots    │
│  ext/       MCP client · extension host · custom tools                                    │
│  media/     image studio     integrations/  GitHub                                        │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Typed RPC

`shared/api.ts` declares the whole surface as a TypeScript interface (`Api`) and the events as `EventMap`. The main process implements it (`electron/api.ts`); the renderer imports the same types, so a call such as `api.git.commit({ message })` is checked end to end. Only one IPC channel (`rpc`) and one event channel exist — adding a feature never means touching the preload script.

## The agent loop (`electron/ai/runtime.ts`)

1. A `send` request creates / resumes a **session** (stored as JSON in the user-data folder).
2. The **context builder** assembles pinned items, `@mentions`, the active file, selection, problems, terminal tail and retrieved files under a token budget, redacting secrets.
3. The **provider adapter** (OpenAI-compatible, Anthropic, Google) streams text, reasoning and tool calls. Tool-call JSON is parsed strictly — a truncated call is an error, never "repaired".
4. Every tool call is **validated** against its JSON schema, then **described** (what will it touch?), then checked by the **permission engine** (`allow` / `ask` / `deny`, last matching rule wins). `ask` pauses the loop and shows the approval sheet.
5. Tools run (read-only ones concurrently) with timeouts and cancellation; file changes are recorded by the **snapshot store** so each turn can be undone.
6. Results go back to the model. Guards: step limit, doom-loop detection, retry with back-off, model fallback via the router, automatic compaction when the window fills.
7. Sub-agents are child sessions run by the same loop with their own tools and permissions.

## Safety model

* The renderer has no Node access; everything goes through the typed RPC.
* API keys live in `credentials.json`, encrypted with Electron `safeStorage` when available.
* Defaults deny reading `.env*`, ask before edits, shell and network, and block destructive commands (`rm -rf /`, `mkfs`, …). Shell commands are split into segments and each segment is judged on its own.
* Paths are normalised and checked against the project root; anything outside needs an explicit `external_dir` approval.
* A content-security-policy limits the renderer to local resources.

## Build & packaging

* `scripts/build-main.mjs` bundles the main process, preload and the TypeScript worker with esbuild (`electron`, `@lydell/node-pty` and `typescript` stay external).
* `vite build` builds the renderer (Monaco workers are bundled locally — no CDN).
* `scripts/package-win.mjs` stages `app.asar`, unpacks the native/worker parts, downloads and slims the Electron runtime, brands the exe with `resedit` and runs `makensis` on `scripts/installer.nsi`.
