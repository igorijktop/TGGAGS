// Boots the *packaged* application payload (build-win/pkg/resources/app.asar) with the Linux Electron binary.
// It proves everything the installer ships works from inside an asar archive: renderer, preload, CSP, bundled
// extensions, the unpacked TypeScript worker, and offline operation (all network access is blocked).
//   node scripts/package-win.mjs && xvfb-run -a node tests/e2e/packaged.mjs
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const asar = resolve('build-win/pkg/resources/app.asar')
if (!existsSync(asar)) { console.error('Run `node scripts/package-win.mjs` first.'); process.exit(2) }
const electronBin = resolve('node_modules/electron/dist/electron')
const ud = mkdtempSync(join(tmpdir(), 'tgg-ud-'))
const project = mkdtempSync(join(tmpdir(), 'tgg-proj-'))
writeFileSync(join(project, 'broken.ts'), 'export const n: number = "not a number"\n')
const outDir = process.env.E2E_OUT ?? join(tmpdir(), 'tgg-packaged'); mkdirSync(outDir, { recursive: true })

const app = await electron.launch({
  executablePath: electronBin, args: ['--no-sandbox', '--disable-gpu', asar, project],
  env: { ...process.env, TGG_USER_DATA: ud, TGG_E2E: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' }
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1400, height: 900 })
const problems = []
page.on('pageerror', e => problems.push('pageerror: ' + e.message))
page.on('console', m => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t) || (m.type() === 'error' && !/Failed to load resource/.test(t))) problems.push(t) })
const rpc = (p, ...a) => page.evaluate(([p, a]) => window.tgg.rpc(p, a).then(r => { if (!r.ok) throw new Error(r.error.message); return r.result }), [p, a])
let failed = false
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed = true }
try {
  await page.waitForSelector('.app, .onb', { timeout: 30000 })
  check(true, 'renderer loads from app.asar')
  const appPath = await app.evaluate(({ app }) => app.getAppPath())
  check(appPath.endsWith('app.asar'), `app path is the asar (${appPath})`)
  const info = await rpc('app.info'); check(!!info.version, `RPC works (v${info.version})`)
  await rpc('settings.update', { ui: { onboarded: true } })
  const exts = await rpc('extensions.bundled'); check(exts.length >= 3, `bundled extensions are found inside the asar (${exts.map(e => e.id).join(', ')})`)
  const tools = await rpc('tools.list'); check(tools.some(t => t.name === 'edit') && tools.some(t => t.name === 'shell'), `agent tools registered (${tools.length})`)
  // TypeScript language service runs from app.asar.unpacked
  await rpc('lsp.open', join(project, 'broken.ts'), 'export const n: number = "not a number"\n', 'typescript', 1)
  let diags = []
  for (let i = 0; i < 40 && !diags.length; i++) { await page.waitForTimeout(500); diags = await rpc('lsp.diagnostics', join(project, 'broken.ts')).catch(() => []) }
  check(diags.some(d => /not assignable/.test(d.message)), 'TypeScript language service starts and reports errors')
  // offline: a request to the internet must fail fast, the UI must stay usable
  const r = await rpc('providers.test', { id: 'x', name: 'x', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', requiresKey: false, models: [], enabled: true }, undefined)
  check(r.ok === false, 'with no network the provider test fails gracefully instead of hanging')
  await page.screenshot({ path: join(outDir, 'packaged.png') })
  check(problems.length === 0, 'no page errors or CSP violations' + (problems.length ? ': ' + problems.join(' | ') : ''))
} catch (e) { console.error('FAILED', e); failed = true; await page.screenshot({ path: join(outDir, 'packaged-failure.png') }).catch(() => {}) }
await app.close().catch(() => {})
console.log(failed ? '\nPACKAGED SMOKE TEST FAILED' : '\nPACKAGED SMOKE TEST PASSED')
process.exit(failed ? 1 : 0)
