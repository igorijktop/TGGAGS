// Screenshots the chat, editor and settings in a dark theme (visual check of contrast).  node tests/e2e/dark-shot.mjs <outDir> [theme-id]
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './launch.mjs'
import { startMock } from './mock-server.mjs'
const out = process.argv[2] ?? '/tmp/dark'; const theme = process.argv[3] ?? 'tgg-dark'; mkdirSync(out, { recursive: true })
const project = mkdtempSync(join(tmpdir(), 'tgg-proj-')); mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'package.json'), '{"name":"demo"}\n'); writeFileSync(join(project, 'src/index.js'), "console.log('hello')\n")
execSync('git init -q && git add -A && git -c user.name=D -c user.email=d@e.co commit -q -m init', { cwd: project })
const mock = await startMock({ delay: 1 })
const { app, page } = await launchApp({ project, width: 1500, height: 940 })
await page.waitForSelector('.app'); await page.waitForTimeout(1000)
await page.evaluate(async ([url, theme]) => { await window.tgg.rpc('settings.update', [{ ui: { onboarded: true }, appearance: { theme }, providers: [{ id: 'mock', name: 'Mock AI', protocol: 'openai', baseUrl: url, requiresKey: false, enabled: true, models: [{ id: 'mock-model', name: 'Mock Model 1', modality: 'chat', contextWindow: 128000, tools: true, reasoning: true }] }], ai: { defaultModel: { provider: 'mock', model: 'mock-model' }, permissionMode: 'yolo' } }]) }, [mock.url, theme])
await page.waitForTimeout(600)
const input = page.locator('.composer-input').first(); await input.click(); await input.fill('Add a greet() helper to src/index.js and make sure it runs'); await page.keyboard.press('Enter')
await page.waitForSelector('.turn-foot', { timeout: 45000 }); await page.waitForTimeout(500)
await page.keyboard.press('Control+P'); await page.waitForSelector('.pal-input input:focus'); await page.keyboard.type('index'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); await page.waitForSelector('.monaco-editor'); await page.waitForTimeout(2500)
await page.screenshot({ path: join(out, 'chat-editor.png') })
await page.locator('.act-item', { hasText: 'Git' }).first().click(); await page.waitForTimeout(600); await page.screenshot({ path: join(out, 'git.png') })
await app.close(); await mock.close()
