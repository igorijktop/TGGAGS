// Development runner: Vite dev server (hot reload for the renderer) + esbuild watch for the main process +
// Electron, which is restarted whenever the main-process bundle changes.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { watch, existsSync } from 'node:fs'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const port = 5173

// 1. main process: initial build, then watch
await new Promise((ok, bad) => spawn('node', ['scripts/build-main.mjs'], { stdio: 'inherit' }).on('exit', c => (c === 0 ? ok() : bad(new Error('main build failed')))))
const watcher = spawn('node', ['scripts/build-main.mjs', '--watch'], { stdio: 'inherit' })

// 2. renderer
const vite = await createServer({ configFile: 'vite.config.ts', server: { port, strictPort: true } })
await vite.listen()
vite.printUrls()

// 3. electron
let child = null
let quitting = false
const start = () => {
  child = spawn(electronBin, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${port}`, ELECTRON_ENABLE_LOGGING: '1' } })
  child.on('exit', code => { if (!quitting && child?.killedByUs !== true) shutdown(code ?? 0) })
}
const restart = () => { if (!child) return; child.killedByUs = true; const old = child; old.once('exit', () => start()); old.kill() }
let timer = null
if (existsSync('dist-electron')) watch('dist-electron', { persistent: true }, (_e, f) => { if (f === 'main.cjs' || f === 'preload.cjs') { clearTimeout(timer); timer = setTimeout(restart, 400) } })
start()

async function shutdown(code = 0) {
  if (quitting) return
  quitting = true
  watcher.kill(); child?.kill(); await vite.close().catch(() => undefined)
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0))
