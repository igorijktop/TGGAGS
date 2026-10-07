// End-to-end check of the in-app updater against a local "release server".
//   xvfb-run -a node tests/e2e/update.mjs      (needs `npm run build` first)
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch.mjs'

const out = process.env.E2E_OUT ?? join(tmpdir(), 'tgg-e2e-update'); mkdirSync(out, { recursive: true })
const log = m => console.log(`  ✓ ${m}`)
const expect = (c, m) => { if (!c) throw new Error('Expectation failed: ' + m) }

const installer = randomBytes(3 * 1024 * 1024)
const manifest = { version: '9.9.9', file: 'TGGAGS-IDE-Setup.exe', sha256: createHash('sha256').update(installer).digest('hex'), size: installer.length, date: '2030-01-01', notes: '## What is new\n- the **Update** button works' }
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/latest.json')) return res.end(JSON.stringify(manifest))
  if (req.url?.startsWith('/TGGAGS-IDE-Setup.exe')) { res.setHeader('content-length', installer.length); return res.end(installer) }
  res.statusCode = 404; res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/latest.json`

const { app, page } = await launchApp({ env: { TGG_UPDATE_MANIFEST: url } })
try {
  await page.waitForSelector('.onb', { timeout: 30000 })
  await page.click('text=Continue'); await page.click('text=Skip for now'); await page.click('.onb-foot .btn.primary'); await page.waitForSelector('.onb', { state: 'detached' })
  await page.waitForSelector('.update-btn', { timeout: 20000 }); log('an Update button appears when a newer version exists')
  await page.click('.update-btn'); await page.waitForSelector('.update-pop')
  const pop = await page.textContent('.update-pop')
  expect(pop.includes('9.9.9') && pop.includes('the Update button works'), 'the popover shows the new version and its notes'); log('the popover shows the version and the release notes')
  await page.screenshot({ path: join(out, 'update-popover.png') })
  await page.click('.update-pop >> text=Update now')
  await page.waitForFunction(() => document.querySelector('.update-btn')?.textContent?.includes('Restart to update'), null, { timeout: 30000 }); log('the installer is downloaded and verified')
  const rpc = (p, ...a) => page.evaluate(([p, a]) => window.tgg.rpc(p, a).then(r => r.result), [p, a])
  const st = await rpc('updates.state'); expect(st.status === 'ready' && st.info.version === '9.9.9', 'state is ready'); log('state is "ready" for 9.9.9')
  console.log('\nUPDATE E2E PASSED')
} catch (e) { console.error('\nUPDATE E2E FAILED:', e.message); await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1 }
finally { await app.close().catch(() => {}); server.closeAllConnections(); server.close() }
