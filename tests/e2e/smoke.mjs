import { launchApp } from './launch.mjs'
const { app, page } = await launchApp()
await page.waitForSelector('#info')
console.log('INFO:', await page.textContent('#info'))
await page.screenshot({ path: process.argv[2] ?? '/tmp/smoke.png' })
await app.close()
