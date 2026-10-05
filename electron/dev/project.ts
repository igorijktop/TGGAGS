import { promises as fsp, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectApi, ProjectDependency, ProjectInfo, ProjectScript } from '../../shared/dev'
import { workspace } from '../services/workspace'
import { run, which } from '../services/proc'
import { walkFiles } from '../services/fileindex'

const readJson = async <T>(p: string): Promise<T | null> => { try { return JSON.parse(await fsp.readFile(p, 'utf8')) as T } catch { return null } }
const readText = async (p: string): Promise<string> => { try { return await fsp.readFile(p, 'utf8') } catch { return '' } }

function scriptKind(name: string): ProjectScript['kind'] {
  if (/^(test|tests|e2e|spec|jest|vitest)(:|$)/.test(name) || /test/.test(name)) return 'test'
  if (/^(build|compile|bundle|package|dist)/.test(name)) return 'build'
  if (/^(dev|start|serve|watch|preview|run)/.test(name)) return 'dev'
  if (/lint|format|typecheck|check/.test(name)) return 'lint'
  return 'other'
}

const LANG_BY_EXT: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', cpp: 'C++', c: 'C', swift: 'Swift', lua: 'Lua', dart: 'Dart' }

async function detect(root: string): Promise<ProjectInfo> {
  const has = (f: string) => existsSync(join(root, f))
  const info: ProjectInfo = { root, languages: [], packageManager: 'none', scripts: [], dependencies: [], testFramework: null, testCommand: null, deploy: [], frameworks: [] }

  // languages by file count
  const files = (await walkFiles(root)).slice(0, 8000)
  const counts = new Map<string, number>()
  for (const f of files) { const l = LANG_BY_EXT[f.split('.').pop()?.toLowerCase() ?? '']; if (l) counts.set(l, (counts.get(l) ?? 0) + 1) }
  info.languages = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0])

  const pkg = await readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; main?: string }>(join(root, 'package.json'))
  if (pkg) {
    info.packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    const runner = info.packageManager === 'npm' ? 'npm run' : info.packageManager === 'bun' ? 'bun run' : info.packageManager
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) info.scripts.push({ name, command, source: 'package.json', kind: scriptKind(name) })
    info.scripts.forEach(s => { s.command = `${runner} ${s.name}` })
    const deps: ProjectDependency[] = [
      ...Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({ name, version, dev: false })),
      ...Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => ({ name, version, dev: true }))
    ]
    info.dependencies = deps.sort((a, b) => a.name.localeCompare(b.name))
    const names = new Set(deps.map(d => d.name))
    for (const [dep, label] of [['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['vite', 'Vite'], ['electron', 'Electron'], ['express', 'Express'], ['fastify', 'Fastify'], ['@angular/core', 'Angular'], ['astro', 'Astro'], ['tailwindcss', 'Tailwind CSS'], ['@nestjs/core', 'NestJS'], ['discord.js', 'discord.js'], ['telegraf', 'Telegraf'], ['grammy', 'grammY'], ['node-telegram-bot-api', 'Telegram Bot API']] as const) if (names.has(dep)) info.frameworks.push(label)
    const testFw = (['vitest', 'jest', 'mocha', '@playwright/test', 'ava', 'cypress'] as const).find(t => names.has(t))
    if (testFw) {
      info.testFramework = testFw.replace('@playwright/', 'playwright')
      info.testCommand = pkg.scripts?.test ? `${runner} test` : testFw === 'vitest' ? 'npx vitest run' : testFw === 'jest' ? 'npx jest' : testFw === 'mocha' ? 'npx mocha' : testFw === '@playwright/test' ? 'npx playwright test' : null
    } else if (pkg.scripts?.test) info.testCommand = `${runner} test`
  }

  const req = await readText(join(root, 'requirements.txt'))
  const pyproject = await readText(join(root, 'pyproject.toml'))
  if (req || pyproject || has('setup.py') || has('Pipfile')) {
    info.packageManager = info.packageManager === 'none' ? (/\[tool\.poetry\]/.test(pyproject) ? 'poetry' : 'pip') : info.packageManager
    for (const l of req.split(/\r?\n/)) { const m = l.match(/^([A-Za-z0-9_.-]+)\s*([=<>!~]=?[^#\s]*)?/); if (m && !l.startsWith('#') && !l.startsWith('-')) info.dependencies.push({ name: m[1], version: m[2] ?? '*', dev: false }) }
    if (/pytest/.test(req + pyproject)) { info.testFramework = 'pytest'; info.testCommand ??= 'python -m pytest' }
    for (const [kw, label] of [['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['aiogram', 'aiogram'], ['telebot', 'pyTelegramBotAPI'], ['python-telegram-bot', 'python-telegram-bot'], ['torch', 'PyTorch'], ['numpy', 'NumPy']] as const) if (new RegExp(kw, 'i').test(req + pyproject)) info.frameworks.push(label)
    if (!info.scripts.length) info.scripts.push({ name: 'run main', command: has('main.py') ? 'python main.py' : has('app.py') ? 'python app.py' : 'python -m <module>', source: 'python', kind: 'dev' })
  }
  if (has('Cargo.toml')) {
    info.packageManager = info.packageManager === 'none' ? 'cargo' : info.packageManager
    info.scripts.push({ name: 'build', command: 'cargo build', source: 'Cargo.toml', kind: 'build' }, { name: 'run', command: 'cargo run', source: 'Cargo.toml', kind: 'dev' }, { name: 'test', command: 'cargo test', source: 'Cargo.toml', kind: 'test' }, { name: 'clippy', command: 'cargo clippy', source: 'Cargo.toml', kind: 'lint' })
    info.testFramework ??= 'cargo test'; info.testCommand ??= 'cargo test'
  }
  if (has('go.mod')) {
    info.packageManager = info.packageManager === 'none' ? 'go' : info.packageManager
    info.scripts.push({ name: 'build', command: 'go build ./...', source: 'go.mod', kind: 'build' }, { name: 'run', command: 'go run .', source: 'go.mod', kind: 'dev' }, { name: 'test', command: 'go test ./...', source: 'go.mod', kind: 'test' }, { name: 'vet', command: 'go vet ./...', source: 'go.mod', kind: 'lint' })
    info.testFramework ??= 'go test'; info.testCommand ??= 'go test ./...'
  }
  if (has('pom.xml')) { info.packageManager = 'maven'; info.scripts.push({ name: 'package', command: 'mvn package', source: 'pom.xml', kind: 'build' }, { name: 'test', command: 'mvn test', source: 'pom.xml', kind: 'test' }); info.testCommand ??= 'mvn test' }
  if (has('build.gradle') || has('build.gradle.kts')) { info.packageManager = 'gradle'; info.scripts.push({ name: 'build', command: 'gradle build', source: 'gradle', kind: 'build' }, { name: 'test', command: 'gradle test', source: 'gradle', kind: 'test' }); info.testCommand ??= 'gradle test' }
  if (files.some(f => /\.(csproj|sln)$/.test(f))) { info.packageManager = info.packageManager === 'none' ? 'dotnet' : info.packageManager; info.scripts.push({ name: 'build', command: 'dotnet build', source: 'dotnet', kind: 'build' }, { name: 'test', command: 'dotnet test', source: 'dotnet', kind: 'test' }); info.testCommand ??= 'dotnet test' }

  const make = await readText(join(root, 'Makefile'))
  for (const m of make.matchAll(/^([A-Za-z0-9_-]+):(?!=)/gm)) if (!/^(\.|all$)/.test(m[1])) info.scripts.push({ name: `make ${m[1]}`, command: `make ${m[1]}`, source: 'Makefile', kind: scriptKind(m[1]) })

  // deployment helpers
  const dep = (id: string, label: string, description: string, file: string, command?: string) => { if (has(file)) info.deploy.push({ id, label, description, file, command }) }
  dep('docker', 'Docker image', 'Build a container image from the Dockerfile.', 'Dockerfile', `docker build -t ${root.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')} .`)
  dep('compose', 'Docker Compose', 'Build and start all services.', 'docker-compose.yml', 'docker compose up --build')
  dep('compose', 'Docker Compose', 'Build and start all services.', 'compose.yaml', 'docker compose up --build')
  dep('vercel', 'Vercel', 'Deploy with the Vercel CLI.', 'vercel.json', 'npx vercel deploy --prod')
  dep('netlify', 'Netlify', 'Deploy with the Netlify CLI.', 'netlify.toml', 'npx netlify deploy --prod')
  dep('cloudflare', 'Cloudflare Workers', 'Deploy with Wrangler.', 'wrangler.toml', 'npx wrangler deploy')
  dep('firebase', 'Firebase', 'Deploy with the Firebase CLI.', 'firebase.json', 'npx firebase deploy')
  dep('fly', 'Fly.io', 'Deploy with flyctl.', 'fly.toml', 'fly deploy')
  dep('heroku', 'Heroku', 'Push to Heroku.', 'Procfile', 'git push heroku HEAD:main')
  dep('render', 'Render', 'Blueprint defined in render.yaml (deploys on push).', 'render.yaml')
  dep('serverless', 'Serverless Framework', 'Deploy with Serverless.', 'serverless.yml', 'npx serverless deploy')
  if (pkg?.scripts?.deploy) info.deploy.push({ id: 'npm-deploy', label: 'npm run deploy', description: pkg.scripts.deploy, file: 'package.json', command: `${info.packageManager === 'npm' ? 'npm run' : info.packageManager} deploy` })
  if (files.some(f => f.startsWith('.github/workflows/'))) info.deploy.push({ id: 'actions', label: 'GitHub Actions', description: 'CI/CD workflows found in .github/workflows (they run on push).', file: '.github/workflows' })
  return info
}

export const projectApi: ProjectApi = {
  async info() { return workspace.root ? detect(workspace.root) : null },
  async installCommand(pkg, dev, uninstall) {
    const info = await detect(workspace.requireRoot())
    const pm = info.packageManager
    const safe = pkg.replace(/[^A-Za-z0-9@/_.~^<>=-]/g, '')
    if (pm === 'pnpm') return uninstall ? `pnpm remove ${safe}` : `pnpm add ${dev ? '-D ' : ''}${safe}`
    if (pm === 'yarn') return uninstall ? `yarn remove ${safe}` : `yarn add ${dev ? '-D ' : ''}${safe}`
    if (pm === 'bun') return uninstall ? `bun remove ${safe}` : `bun add ${dev ? '-d ' : ''}${safe}`
    if (pm === 'pip') return uninstall ? `pip uninstall -y ${safe}` : `pip install ${safe}`
    if (pm === 'poetry') return uninstall ? `poetry remove ${safe}` : `poetry add ${dev ? '--group dev ' : ''}${safe}`
    if (pm === 'cargo') return uninstall ? `cargo remove ${safe}` : `cargo add ${safe}`
    if (pm === 'go') return uninstall ? `go mod tidy` : `go get ${safe}`
    return uninstall ? `npm uninstall ${safe}` : `npm install ${dev ? '-D ' : ''}${safe}`
  },
  async outdated() {
    const root = workspace.requireRoot()
    if (!existsSync(join(root, 'package.json')) || !which('npm')) return []
    const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['outdated', '--json'], { cwd: root, timeoutMs: 60_000 })
    try {
      const j = JSON.parse(r.stdout || '{}') as Record<string, { current?: string; wanted: string; latest: string }>
      return Object.entries(j).map(([name, v]) => ({ name, current: v.current ?? '', wanted: v.wanted, latest: v.latest }))
    } catch { return [] }
  }
}
