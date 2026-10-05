import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: ['tests/unit/helpers/setup.ts'],
    pool: 'forks',
    fileParallelism: false
  },
  resolve: { alias: { electron: resolve(import.meta.dirname, 'tests/unit/helpers/electron-mock.ts') } }
})
