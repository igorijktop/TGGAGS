import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  plugins: [react()],
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
