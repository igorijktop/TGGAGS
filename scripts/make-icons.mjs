// Renders the app icon (resources/icon.png + icon.ico) and the installer artwork (BMP) with headless Chromium.
// Run: node scripts/make-icons.mjs   (needs a Chromium: PLAYWRIGHT_BROWSERS_PATH or CHROME_PATH)
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const out = 'resources'
mkdirSync(out, { recursive: true })

const logo = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E2805D"/><stop offset="1" stop-color="#B24E2D"/></linearGradient></defs>
<rect x="4" y="4" width="56" height="56" rx="16" fill="url(#g)"/>
<path d="M24 22 14 32l10 10" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M34 44 42 20" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".92"/>
<path d="M47 14l1.8 4.4 4.4 1.8-4.4 1.8L47 26.4l-1.8-4.4-4.4-1.8 4.4-1.8z" fill="#FFE9DD"/></svg>`

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (existsSync(base)) for (const d of readdirSync(base)) { const p = join(base, d, 'chrome-linux', 'chrome'); if (d.startsWith('chromium-') && existsSync(p)) return p }
  return undefined
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] })
const page = await browser.newPage({ deviceScaleFactor: 1 })

async function png(html, w, h, transparent = true) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<html><body style="margin:0;background:${transparent ? 'transparent' : '#fff'};width:${w}px;height:${h}px;overflow:hidden">${html}</body></html>`)
  return page.screenshot({ type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } })
}

// ICO with PNG-compressed entries
const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = []
for (const s of sizes) pngs.push(await png(logo(s), s, s))
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const dir = Buffer.alloc(16 * sizes.length)
sizes.forEach((s, i) => { const o = i * 16; dir[o] = s === 256 ? 0 : s; dir[o + 1] = s === 256 ? 0 : s; dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(offset, o + 12); offset += pngs[i].length })
writeFileSync(join(out, 'icon.ico'), Buffer.concat([head, dir, ...pngs]))
writeFileSync(join(out, 'icon.png'), await png(logo(512), 512, 512))

// 24-bit BMP from a rendered page (NSIS wants BMPs for wizard artwork)
async function bmp(file, html, w, h) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${html}</body></html>`)
  const dataUrl = await page.evaluate(async () => { const el = document.body; void el; return '' })
  void dataUrl
  const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } })
  const px = await page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data)
  }, shot.toString('base64'))
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const buf = Buffer.alloc(54 + rowSize * h)
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowSize * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * rowSize + x * 3; buf[d] = px[s + 2]; buf[d + 1] = px[s + 1]; buf[d + 2] = px[s] }
  writeFileSync(join(out, file), buf)
}
const font = "font-family:'Segoe UI',Inter,system-ui,sans-serif"
await bmp('installer-sidebar.bmp', `<div style="width:164px;height:314px;background:linear-gradient(170deg,#FCFBF8,#F1E6DC);position:relative;${font}">
  <div style="position:absolute;left:34px;top:36px">${logo(96)}</div>
  <div style="position:absolute;left:0;right:0;top:150px;text-align:center;font-size:21px;font-weight:600;color:#1F1E1B;letter-spacing:-.01em">TGGAGS</div>
  <div style="position:absolute;left:14px;right:14px;top:182px;text-align:center;font-size:11.5px;line-height:1.5;color:#68655D">The AI code editor<br>that lives on your<br>computer</div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:6px;background:#C4623F"></div></div>`, 164, 314)
await bmp('installer-header.bmp', `<div style="width:150px;height:57px;background:#FCFBF8;display:flex;align-items:center;justify-content:flex-end;padding-right:14px;box-sizing:border-box">${logo(38)}</div>`, 150, 57)
await browser.close()
console.log('icons written to', out)
