import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/** Locks the production renderer down to local resources (no remote scripts, frames or connections). */
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: tgg-file:", "font-src 'self' data:",
  "connect-src 'self' tgg-file:", "worker-src 'self' blob:", "media-src 'self' blob: data: tgg-file:", "frame-src tgg-file:", "object-src 'none'", "base-uri 'none'", "form-action 'none'"
].join('; ')
const csp = (): Plugin => ({ name: 'tgg-csp', apply: 'build', transformIndexHtml: html => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`) })

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  plugins: [react(), csp()],
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'shared') } },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome140',
    chunkSizeWarningLimit: 6000,
    sourcemap: false
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true }
})
