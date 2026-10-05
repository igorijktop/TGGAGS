// Usage: node tests/e2e/shot.mjs <out.png> [projectDir] [js to run after load]
import { launchApp } from './launch.mjs'
const [out = '/tmp/shot.png', project, script] = process.argv.slice(2)
const { app, page } = await launchApp({ project })
await page.waitForSelector('.app', { timeout: 30000 })
await page.waitForTimeout(1800)
if (script) { await page.evaluate(script); await page.waitForTimeout(1200) }
await page.screenshot({ path: out })
console.log('saved', out)
await app.close()
