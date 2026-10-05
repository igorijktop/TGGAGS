// Builds the Windows distribution of the app, and (with --installer) a single offline NSIS installer .exe.
//
//   node scripts/package-win.mjs                 → build-win/pkg/  (a ready-to-run app folder: TGGAGS IDE.exe + resources)
//   node scripts/package-win.mjs --installer     → release/TGGAGS-IDE-Setup.exe  (needs `makensis`)
//
// Works on Linux, macOS and Windows (CI uses windows-latest). It downloads the official Electron runtime once
// (cached in build-win/cache) – the produced installer itself needs no network at install time or at run time.
import { spawnSync } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import * as asar from '@electron/asar'
import * as ResEdit from 'resedit'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const args = new Set(process.argv.slice(2))
const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'))
const electronVersion = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version
const PRODUCT = pkgJson.productName ?? 'TGGAGS IDE'
const EXE_NAME = 'TGGAGS IDE.exe'
const work = resolve('build-win'), cache = join(work, 'cache'), appDir = join(work, 'app'), pkgDir = join(work, 'pkg')
const log = (...a) => console.log('›', ...a)
const mb = n => (n / 1048576).toFixed(1) + ' MiB'

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status ?? r.error?.message})`)
}
const rm = p => rmSync(p, { recursive: true, force: true })
function dirSize(p) { let n = 0; for (const e of readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? dirSize(join(p, e.name)) : statSync(join(p, e.name)).size; return n }

// ───────── 1. build ─────────
if (!args.has('--skip-build')) { log('building main process + renderer'); run('node', ['scripts/build-main.mjs', '--production']); run('npx', ['vite', 'build']) }
for (const f of ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/ts-worker.cjs']) if (!existsSync(f)) throw new Error(`Missing ${f} – run the build first.`)

// ───────── 2. stage the app (what goes into app.asar) ─────────
log('staging application files')
rm(appDir); mkdirSync(join(appDir, 'dist-electron'), { recursive: true })
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: pkgJson.name, productName: PRODUCT, version: pkgJson.version, description: pkgJson.description, author: pkgJson.author, license: pkgJson.license, main: 'dist-electron/main.cjs' }, null, 2))
cpSync('dist', join(appDir, 'dist'), { recursive: true })
// Monaco's own TypeScript worker is never started (the IDE has its own language service) – don't ship its 6.7 MB
for (const f of readdirSync(join(appDir, 'dist/assets'))) if (/^ts\.worker-.*\.js$/.test(f)) rm(join(appDir, 'dist/assets', f))
for (const f of ['main.cjs', 'preload.cjs', 'ts-worker.cjs']) copyFileSync(join('dist-electron', f), join(appDir, 'dist-electron', f))
cpSync('extensions', join(appDir, 'extensions'), { recursive: true })
mkdirSync(join(appDir, 'resources'), { recursive: true })
copyFileSync('resources/icon.png', join(appDir, 'resources/icon.png'))

// typescript (language service for JS/TS) – only what the worker needs
const tsSrc = 'node_modules/typescript', tsDst = join(appDir, 'node_modules/typescript')
mkdirSync(join(tsDst, 'lib'), { recursive: true })
copyFileSync(join(tsSrc, 'package.json'), join(tsDst, 'package.json'))
for (const f of readdirSync(join(tsSrc, 'lib'))) if (f === 'typescript.js' || (f.startsWith('lib.') && f.endsWith('.d.ts'))) copyFileSync(join(tsSrc, 'lib', f), join(tsDst, 'lib', f))
if (existsSync(join(tsSrc, 'LICENSE.txt'))) copyFileSync(join(tsSrc, 'LICENSE.txt'), join(tsDst, 'LICENSE.txt'))

// node-pty (integrated terminal): JS wrapper + the prebuilt Windows binaries
const ptyVersion = JSON.parse(readFileSync('node_modules/@lydell/node-pty/package.json', 'utf8')).version
cpSync('node_modules/@lydell/node-pty', join(appDir, 'node_modules/@lydell/node-pty'), { recursive: true })
const ptyWin = join(appDir, 'node_modules/@lydell/node-pty-win32-x64')
mkdirSync(cache, { recursive: true })
const ptyTgz = join(cache, `lydell-node-pty-win32-x64-${ptyVersion}.tgz`)
if (!existsSync(ptyTgz)) {
  log('fetching @lydell/node-pty-win32-x64@' + ptyVersion)
  run('npm', ['pack', `@lydell/node-pty-win32-x64@${ptyVersion}`, '--pack-destination', cache, '--silent'])
  const packed = join(cache, `lydell-node-pty-win32-x64-${ptyVersion}.tgz`)
  if (!existsSync(packed)) throw new Error('npm pack did not produce the expected tarball')
}
const ptyTmp = join(work, 'pty-tmp'); rm(ptyTmp); mkdirSync(ptyTmp, { recursive: true })
run('tar', ['-xzf', ptyTgz, '-C', ptyTmp])
cpSync(join(ptyTmp, 'package'), ptyWin, { recursive: true }); rm(ptyTmp)
// node-pty's own package.json must not drag other platforms' optional deps in
log('app staged:', mb(dirSize(appDir)))

// ───────── 3. Electron runtime ─────────
const zipName = `electron-v${electronVersion}-win32-x64.zip`, zipPath = join(cache, zipName)
if (!existsSync(zipPath) || statSync(zipPath).size < 50e6) {
  log('downloading', zipName)
  const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${zipName}`
  const curl = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', zipPath, url], { stdio: 'inherit' })
  if (curl.status !== 0) {
    const res = await fetch(url); if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    await new Promise((ok, bad) => { const w = createWriteStream(zipPath); res.body ? (async () => { for await (const c of res.body) w.write(c); w.end(ok) })().catch(bad) : bad(new Error('no body')) })
  }
}
log('extracting Electron runtime', electronVersion)
rm(pkgDir); mkdirSync(pkgDir, { recursive: true })
const files = unzipSync(new Uint8Array(readFileSync(zipPath)))
for (const [name, data] of Object.entries(files)) {
  if (name.endsWith('/')) { mkdirSync(join(pkgDir, name), { recursive: true }); continue }
  const dest = join(pkgDir, name); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, data)
}

// slim down: drop things the IDE never uses
rm(join(pkgDir, 'resources/default_app.asar'))
// WebGPU shader compiler and the Vulkan software renderer: unused (the UI is plain 2D/DOM) and ~15 MB uncompressed
for (const f of ['dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll']) rm(join(pkgDir, f))
const keepLocales = new Set(['en-US.pak', 'ru.pak', 'uk.pak'])  // Chromium UI strings (spell-check menu, dialogs)
for (const f of readdirSync(join(pkgDir, 'locales'))) if (!keepLocales.has(f)) rm(join(pkgDir, 'locales', f))

// ───────── 4. app.asar ─────────
log('creating app.asar')
await asar.createPackageWithOptions(appDir, join(pkgDir, 'resources/app.asar'), {
  unpack: '{**/ts-worker.cjs,**/*.node,**/*.dll,**/*.exe}',
  unpackDir: '{node_modules/@lydell,node_modules/typescript}'
})
copyFileSync('resources/icon.png', join(pkgDir, 'resources/icon.png'))
if (existsSync('LICENSE')) copyFileSync('LICENSE', join(pkgDir, 'LICENSE.txt'))

// ───────── 5. branding of the exe (icon + version info) ─────────
log('branding executable')
const exeIn = join(pkgDir, 'electron.exe'), exeOut = join(pkgDir, EXE_NAME)
{
  const exe = ResEdit.NtExecutable.from(readFileSync(exeIn), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const ico = ResEdit.Data.IconFile.from(readFileSync('resources/icon.ico'))
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  const g = groups[0] ?? { id: 1, lang: 1033 }
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map(i => i.data))
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  const vi = vis[0] ?? ResEdit.Resource.VersionInfo.createEmpty()
  const [maj, min, pat] = pkgJson.version.split('.').map(n => parseInt(n, 10) || 0)
  vi.setFileVersion(maj, min, pat, 0, 1033); vi.setProductVersion(maj, min, pat, 0, 1033)
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: PRODUCT, FileDescription: PRODUCT, CompanyName: pkgJson.author ?? 'TGGAGS', LegalCopyright: `Copyright © ${new Date().getFullYear()} ${pkgJson.author ?? 'TGGAGS'}`, OriginalFilename: EXE_NAME, InternalName: 'TGGAGS', ProductVersion: pkgJson.version, FileVersion: pkgJson.version })
  vi.outputToResourceEntries(res.entries)
  res.outputResource(exe)
  writeFileSync(exeOut, Buffer.from(exe.generate()))
  rm(exeIn)
}
log('app folder ready:', pkgDir, '(' + mb(dirSize(pkgDir)) + ')')

// sanity checks on the result
{
  const list = asar.listPackage(join(pkgDir, 'resources/app.asar')).map(p => p.split(sep).join('/'))
  for (const need of ['/dist/index.html', '/dist-electron/main.cjs', '/dist-electron/preload.cjs', '/package.json']) if (!list.includes(need)) throw new Error('app.asar is missing ' + need)
  const unpacked = join(pkgDir, 'resources/app.asar.unpacked')
  for (const need of ['dist-electron/ts-worker.cjs', 'node_modules/typescript/lib/typescript.js', 'node_modules/@lydell/node-pty-win32-x64']) if (!existsSync(join(unpacked, need))) throw new Error('app.asar.unpacked is missing ' + need)
  const head = readFileSync(exeOut).subarray(0, 2).toString('latin1')
  if (head !== 'MZ') throw new Error('Executable is not a valid PE file')
  log('sanity checks passed')
}
if (!args.has('--installer')) process.exit(0)

// ───────── 6. NSIS installer ─────────
const outDir = resolve('release'); mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'TGGAGS-IDE-Setup.exe'); rm(outFile)
const makensis = process.env.MAKENSIS ?? (process.platform === 'win32' ? ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].find(existsSync) ?? 'makensis' : 'makensis')
log('building installer with', makensis)
run(makensis, ['-V2', `-DVERSION=${pkgJson.version}`, `-DPRODUCT=${PRODUCT}`, `-DEXE=${EXE_NAME}`, `-DSRC=${pkgDir}`, `-DOUT=${outFile}`, `-DRES=${resolve('resources')}`, resolve('scripts/installer.nsi')])
const bytes = readFileSync(outFile)
writeFileSync(outFile + '.sha256', `${createHash('sha256').update(bytes).digest('hex')}  ${'TGGAGS-IDE-Setup.exe'}\n`)
log('installer:', outFile, mb(bytes.length))
if (bytes.length > 98 * 1048576) console.warn('! The installer is larger than GitHub’s 100 MiB per-file limit – publish it as a release asset instead of committing it.')
void renameSync
