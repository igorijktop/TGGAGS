// Shared helper: launches the built app with Playwright's Electron driver (under Xvfb in CI/containers).
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export async function launchApp({ userData, project, env = {}, width = 1480, height = 920 } = {}) {
  const ud = userData ?? mkdtempSync(join(tmpdir(), 'tgg-ud-'))
  mkdirSync(ud, { recursive: true })
  const args = ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', resolve('.')]
  if (project) args.push(project)
  const app = await electron.launch({
    args, cwd: resolve('.'),
    env: { ...process.env, TGG_USER_DATA: ud, TGG_E2E: '1', TGG_NO_RESTORE: project ? '' : '1', ELECTRON_ENABLE_LOGGING: '1', ...env }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width, height }).catch(() => {})
  page.on('pageerror', e => console.error('[pageerror]', e.message))
  page.on('console', m => { if (m.type() === 'error') console.error('[console.error]', m.text()) })
  return { app, page, userData: ud }
}
