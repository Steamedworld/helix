import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@helix/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
})
