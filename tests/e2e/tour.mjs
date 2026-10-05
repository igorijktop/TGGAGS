// Visits every view and page of the app and screenshots each one (visual review + crash detection).
// Usage: xvfb-run -a -s "-screen 0 1600x1000x24" node tests/e2e/tour.mjs <outDir> [theme-id]
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch.mjs'
import { startMock } from './mock-server.mjs'

const out = process.argv[2] ?? '/tmp/tour'
const theme = process.argv[3]
mkdirSync(out, { recursive: true })
const project = mkdtempSync(join(tmpdir(), 'tgg-proj-'))
mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0', type: 'module', scripts: { start: 'node src/index.js', test: 'node --test', build: 'echo build' }, dependencies: { express: '^4.19.0' } }, null, 2) + '\n')
writeFileSync(join(project, 'src/index.js'), "import http from 'node:http'\n\nexport function greet(name) {\n  return `Hello, ${name}!`\n}\n\nconst server = http.createServer((req, res) => {\n  res.end(greet('world'))\n})\n\nserver.listen(3000, () => console.log('listening on 3000'))\n")
writeFileSync(join(project, 'README.md'), '# Demo app\n\nA tiny project used for screenshots.\n\n- **fast**\n- _small_\n\n```js\nconsole.log("hi")\n```\n')
execSync('git init -q && git add -A && git -c user.name=Demo -c user.email=demo@example.com commit -q -m "Initial commit" && echo "// wip" >> src/index.js && echo "notes" > notes.txt', { cwd: project })

const mock = await startMock({ delay: 2 })
const { app, page } = await launchApp({ project, width: 1500, height: 940 })
const errors = []
page.on('pageerror', e => errors.push(e.message))
const shot = async name => { await page.waitForTimeout(450); await page.screenshot({ path: join(out, name + '.png') }); console.log('shot', name) }
const rpc = (p, ...a) => page.evaluate(([p, a]) => window.tgg.rpc(p, a), [p, a])
const view = async id => { await page.click(`.act-item[data-view="${id}"], .act-item:has(.act-label:text-is("${id}"))`).catch(() => {}) }
try {
  await page.waitForSelector('.app', { timeout: 30000 })
  await page.waitForTimeout(1500)
  await rpc('settings.update', { ui: { onboarded: true }, providers: [{ id: 'mock', name: 'Mock AI', protocol: 'openai', baseUrl: mock.url, requiresKey: false, enabled: true, models: [{ id: 'mock-model', name: 'Mock Model 1', modality: 'chat', contextWindow: 128000, tools: true, vision: true, reasoning: true }, { id: 'mock-img', name: 'Mock Image', modality: 'image' }] }], ai: { defaultModel: { provider: 'mock', model: 'mock-model' }, permissionMode: 'yolo' } })
  if (theme) await rpc('settings.update', { appearance: { theme } })
  await page.waitForTimeout(700)
  await page.evaluate(() => window.dispatchEvent(new Event('tgg:focus-composer')))
  await shot('00-home-state')
  // run a chat so the panel has content
  const input = page.locator('.composer-input').first()
  await input.click(); await input.fill('Add a greet() helper to src/index.js and make sure it runs'); await page.keyboard.press('Enter')
  await page.waitForSelector('.turn-foot', { timeout: 45000 })
  await shot('01-chat-done')
  // sidebar views
  for (const [label, name] of [['Search', '02-search'], ['Git', '03-git'], ['Run', '04-run'], ['Extensions', '05-extensions'], ['AI Chats', '06-chats'], ['Agents', '07-agents'], ['Models', '08-models'], ['Images', '09-images'], ['GitHub', '10-github'], ['Explorer', '11-explorer']]) {
    await page.locator('.act-item', { hasText: label }).first().click()
    if (label === 'Search') { await page.keyboard.type('greet'); await page.waitForTimeout(800) }
    await shot(name)
  }
  // open a file, the panel, pages
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tgg:test-open', {})))
  const open = async (cmd, name, wait = 700) => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); await page.keyboard.press('Control+Shift+P'); await page.waitForSelector('.pal-input input:focus'); await page.keyboard.press('Control+A'); await page.keyboard.type((cmd.startsWith('Go to') ? '' : '>') + cmd); await page.waitForTimeout(250); await page.keyboard.press('Enter'); await page.waitForTimeout(wait); await shot(name) }
  await open('Go to File', '12-palette-files', 300).catch(() => {})
  await page.keyboard.press('Escape')
  await page.locator('.tree-row', { hasText: 'index.js' }).first().dblclick().catch(() => {})
  await page.waitForTimeout(1200)
  await shot('13-editor')
  await open('Toggle Terminal', '14-terminal', 1500)
  await open('Show Problems', '15-problems', 600).catch(() => {})
  await open('Open Settings', '16-settings', 900)
  for (const sec of ['Appearance', 'Editor', 'AI & agents', 'Permissions', 'Keyboard shortcuts', 'Hooks', 'About']) { await page.locator('.set-nav-item', { hasText: sec }).first().click().catch(() => {}); await shot('17-settings-' + sec.toLowerCase().replace(/[^a-z]+/g, '-')) }
  await open('Manage Models', '18-models-page', 900).catch(() => {})
  await open('Open Image Studio', '19-images-page', 900).catch(() => {})
  await open('Open Home', '20-home', 900).catch(() => {})
  await open('Benchmark Models', '21-bench', 900).catch(() => {})
  console.log('page errors:', errors.length ? errors : 'none')
} catch (e) {
  console.error('FAILED', e)
  await shot('failed').catch(() => {})
  process.exitCode = 1
} finally {
  await app.close(); await mock.close()
}
