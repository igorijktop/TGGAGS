// End-to-end regression test: drives the real Electron app against a mock model server.
//   xvfb-run -a node tests/e2e/run.mjs            (needs `npm run build` first)
// Exits non-zero on the first failed expectation and always prints a screenshot path for debugging.
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch.mjs'
import { startMock } from './mock-server.mjs'

const outDir = process.env.E2E_OUT ?? join(tmpdir(), 'tgg-e2e')
mkdirSync(outDir, { recursive: true })
let step = 0
const log = m => console.log(`  ✓ ${m}`)
function expect(cond, msg) { if (!cond) throw new Error('Expectation failed: ' + msg) }

const project = mkdtempSync(join(tmpdir(), 'tgg-proj-'))
mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', scripts: { start: 'node src/index.js' } }, null, 2) + '\n')
writeFileSync(join(project, 'src/index.js'), "console.log('hello')\n")
execSync('git init -q && git add -A && git -c user.name=T -c user.email=t@example.com commit -q -m init', { cwd: project })

const mock = await startMock({ delay: 1 })
const { app, page } = await launchApp({ project, width: 1500, height: 940 })
const problems = []
page.on('pageerror', e => problems.push('pageerror: ' + e.message))
page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t)) problems.push('console: ' + t); if (/Content Security Policy|Refused to/i.test(t)) problems.push('CSP: ' + t) })
const rpc = (p, ...a) => page.evaluate(([p, a]) => window.tgg.rpc(p, a).then(r => { if (!r.ok) throw new Error(r.error.message); return r.result }), [p, a])
const shot = async name => page.screenshot({ path: join(outDir, `${String(++step).padStart(2, '0')}-${name}.png`) })

try {
  console.log('first run')
  await page.waitForSelector('.app', { timeout: 30000 })
  await page.waitForSelector('.onb', { timeout: 10000 })
  log('welcome guide is shown on a fresh install'); await shot('onboarding')
  await page.click('text=Continue'); await page.waitForSelector('text=Connect an AI model'); log('step 2: connect a model')
  await page.click('text=Skip for now'); await page.waitForSelector('text=Open a folder'); log('step 3: open a folder')
  await page.click('.onb-foot .btn.primary'); await page.waitForSelector('.onb', { state: 'detached', timeout: 5000 }); log('welcome guide can be finished')
  const info = await rpc('app.info'); expect(info.version && info.electron, 'app.info returns versions'); log(`running Electron ${info.electron}`)

  console.log('model setup')
  await rpc('settings.update', { providers: [{ id: 'mock', name: 'Mock AI', protocol: 'openai', baseUrl: mock.url, requiresKey: false, enabled: true, models: [{ id: 'mock-model', name: 'Mock Model 1', modality: 'chat', contextWindow: 128000, tools: true, vision: true, reasoning: true }] }], ai: { defaultModel: { provider: 'mock', model: 'mock-model' }, permissionMode: 'auto-edit' } })
  await page.waitForSelector('.sel-btn.model:has-text("Mock Model 1")', { timeout: 10000 }); log('provider appears in the model picker')

  console.log('agent run')
  expect(await page.locator('.ai-panel').count() === 0, 'no side panel by default: the conversation lives in the main window')
  expect(await page.locator('.tab:has-text("Chat")').count() === 1, 'the permanent Chat tab is there'); log('the main window is the chat (no right-hand panel)')
  expect(await page.locator('.main-col .home-hero').count() === 1, 'welcome screen with the message box in the main window'); await shot('home')
  const input = page.locator('.composer-input').first()
  await input.click(); await input.fill('Add a greet() helper to src/index.js and make sure it runs'); await page.keyboard.press('Enter')
  await page.waitForSelector('.main-col .chat.page .tool', { timeout: 20000 }); log('the welcome screen turns into the conversation; tool cards stream in')
  await page.waitForSelector('.sheet.perm', { timeout: 30000 }); log('the shell command asks for permission (auto-edit mode)')
  expect((await page.textContent('.sheet.perm')).includes('node src/index.js'), 'the sheet shows the command'); await shot('permission')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.turn-foot', { timeout: 40000 }); log('the turn finishes')
  expect(readFileSync(join(project, 'src/index.js'), 'utf8').includes('export function greet'), 'the file on disk was edited')
  log('the edit reached the disk')
  expect(await page.locator('.md table').count() > 0 && await page.locator('.codeblock').count() > 0, 'markdown table and code block render'); log('markdown renders (table, code block)')
  expect((await page.textContent('.changes-bar')).includes('1 file'), 'changes bar summarises the edit'); log('changes bar shows the edited file')
  await shot('done')

  console.log('questions')
  await input.click(); await input.fill('ASKME which package manager?'); await page.keyboard.press('Enter')
  await page.waitForSelector('.sheet.question', { timeout: 20000 }); log('the agent can ask the user a question'); await shot('question')
  await page.click('.q-opt:has-text("pnpm")'); await page.click('.sheet.question .btn.primary'); await page.waitForSelector('.sheet.question', { state: 'detached', timeout: 10000 })
  await page.waitForFunction(() => document.body.innerText.includes('package manager you chose'), null, { timeout: 20000 }); log('the answer is sent back and the run continues')

  console.log('undo')
  await page.locator('.turn').first().locator('.turn-foot >> text=Undo').click(); await page.waitForSelector('.dialog'); log('undoing an earlier turn asks for confirmation'); await page.click('.dialog .btn.danger'); await page.waitForTimeout(800)
  expect(readFileSync(join(project, 'src/index.js'), 'utf8') === "console.log('hello')\n", 'undo restored the original file'); log('Undo restores the file')

  console.log('navigation')
  for (const label of ['Search', 'Git', 'Run', 'Extensions', 'AI Chats', 'Agents', 'Models', 'Images', 'GitHub', 'Explorer']) { await page.locator('.act-item', { hasText: label }).first().click(); await page.waitForTimeout(250) }
  log('every sidebar view opens without errors')
  await page.locator('.act-item', { hasText: 'Git' }).first().click(); await page.waitForSelector('.commit-box'); log('source control view renders')

  console.log('terminal')
  await page.keyboard.press('Control+Backquote'); await page.waitForSelector('.xterm', { timeout: 15000 }); log('terminal panel opens')
  await page.waitForTimeout(1500); await page.keyboard.type('echo tgg-e2e-ok'); await page.keyboard.press('Enter'); await page.waitForTimeout(1200)
  const buf = await rpc('terminal.list').then(l => rpc('terminal.buffer', l[0].id)); expect(buf.includes('tgg-e2e-ok'), 'terminal echoed the command'); log('commands run in the terminal'); await shot('terminal')

  console.log('settings & themes')
  await page.keyboard.press('Control+Shift+P'); await page.waitForSelector('.pal-input input:focus'); await page.keyboard.type('Open Settings'); await page.waitForTimeout(250); await page.keyboard.press('Enter')
  await page.waitForSelector('.settings'); await page.click('.set-nav-item:has-text("Appearance")'); await page.click('button[aria-label="Midnight theme"]')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'tgg-midnight', null, { timeout: 5000 }); log('switching theme applies immediately'); await shot('midnight')

  console.log('editor')
  await page.keyboard.press('Control+P'); await page.waitForSelector('.pal-input input:focus'); await page.keyboard.type('index.js'); await page.waitForTimeout(300); await page.keyboard.press('Enter')
  await page.waitForSelector('.monaco-editor', { timeout: 15000 }); log('files open in the editor')
  await page.locator('.tab:has-text("Chat")').click(); await page.waitForSelector('.main-col .chat.page .turn-foot'); log('the Chat tab brings the conversation back'); await shot('back-to-chat')
  await page.keyboard.press('Control+Alt+B'); await page.locator('.tab:has-text("index.js")').click(); await page.waitForSelector('.ai-panel .chat'); log('the optional side chat appears beside the files')
  await page.keyboard.press('Control+Alt+B')

  expect(problems.length === 0, 'no page errors / CSP violations:\n    ' + problems.join('\n    '))
  log('no page errors or CSP violations')
  console.log('\nALL E2E CHECKS PASSED')
} catch (e) {
  console.error('\nE2E FAILED:', e.message)
  if (problems.length) console.error('Collected problems:\n  ' + problems.join('\n  '))
  await shot('failure').catch(() => {})
  console.error('screenshots in', outDir)
  process.exitCode = 1
} finally {
  await app.close().catch(() => {}); await mock.close()
}
