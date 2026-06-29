import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Resolve @pmndrs/scheduler to the repo source for live editing.
export default defineConfig({
  resolve: {
    alias: {
      '@pmndrs/scheduler': resolve(__dirname, '../../src/index.ts'),
    },
  },
})
