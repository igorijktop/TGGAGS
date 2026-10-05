// Bundles the Electron main process, preload and worker entry points with esbuild.
import { build, context } from 'esbuild'
import { rmSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production')

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: production ? false : 'linked',
  minify: false,
  logLevel: 'info',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  // Native / runtime-resolved modules stay external and are shipped alongside the app.
  external: ['electron', '@lydell/node-pty', 'typescript'],
  define: { 'process.env.TGG_PRODUCTION': JSON.stringify(production ? '1' : '') },
  loader: { '.md': 'text' }
}

const entries = {
  main: 'electron/main.ts',
  preload: 'electron/preload.ts',
  'ts-worker': 'electron/dev/ts-worker.ts'
}

if (!watch) { rmSync('dist-electron', { recursive: true, force: true }); mkdirSync('dist-electron', { recursive: true }) }

const opts = { ...common, entryPoints: entries }
if (watch) {
  const ctx = await context(opts)
  await ctx.watch()
  console.log('[esbuild] watching main process…')
} else {
  await build(opts)
}
