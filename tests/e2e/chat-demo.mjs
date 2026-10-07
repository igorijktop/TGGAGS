// Drives the real UI against the mock model server and takes screenshots of each stage.
// Usage: xvfb-run -a -s "-screen 0 1600x1000x24" node tests/e2e/chat-demo.mjs <outDir>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch.mjs'
import { startMock } from './mock-server.mjs'

const out = process.argv[2] ?? '/tmp/chat-demo'
mkdirSync(out, { recursive: true })
const project = mkdtempSync(join(tmpdir(), 'tgg-proj-'))
mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0', type: 'module', scripts: { start: 'node src/index.js' } }, null, 2) + '\n')
writeFileSync(join(project, 'src/index.js'), "console.log('hello')\n")
writeFileSync(join(project, 'README.md'), '# Demo app\n\nA tiny project used for screenshots.\n')

const mock = await startMock()
const { app, page } = await launchApp({ project, width: Number(process.env.E2E_W ?? 1500), height: Number(process.env.E2E_H ?? 940) })
const shot = async name => { await page.screenshot({ path: join(out, name + '.png') }); console.log('shot', name) }
try {
  await page.waitForSelector('.app', { timeout: 30000 })
  await page.waitForTimeout(1500)
  // register the mock provider through the same RPC the UI uses
  await page.evaluate(async url => {
    const call = (p, ...a) => window.tgg.rpc(p, a)
    await call('settings.update', { providers: [{ id: 'mock', name: 'Mock AI', protocol: 'openai', baseUrl: url, requiresKey: false, enabled: true, models: [{ id: 'mock-model', name: 'Mock Model 1', modality: 'chat', contextWindow: 128000, tools: true, vision: true, reasoning: true }] }], ai: { defaultModel: { provider: 'mock', model: 'mock-model' } } })
  }, mock.url)
  await page.waitForTimeout(600)
  await shot('01-empty-chat')
  const input = page.locator('.composer-input').first()
  await input.click()
  await input.fill('Add a greet() helper to src/index.js and make sure it runs')
  await shot('02-typed')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1800)
  await shot('03-streaming')
  // approve the shell command when it is asked for
  await page.waitForSelector('.sheet.perm', { timeout: 30000 })
  await page.waitForTimeout(400)
  await shot('04-permission')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.turn-foot', { timeout: 40000 })
  await page.waitForTimeout(800)
  await shot('05-done')
  console.log('requests to mock:', mock.requests.length)
} catch (e) {
  console.error('FAILED', e)
  await shot('failed').catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
  await mock.close()
}
