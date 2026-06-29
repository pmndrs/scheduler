import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Resolve @pmndrs/scheduler to the repo source for live editing.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pmndrs/scheduler/react': resolve(__dirname, '../../src/react.ts'),
      '@pmndrs/scheduler': resolve(__dirname, '../../src/index.ts'),
    },
  },
})
