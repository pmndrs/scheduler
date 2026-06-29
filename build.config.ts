import { defineBuildConfig } from 'unbuild'

/**
 * Unbuild configuration for @pmndrs/scheduler
 *
 * Two entry points:
 * - `.`       → src/index.ts  (vanilla, framework-agnostic core)
 * - `./react` → src/react.ts  (useFrame hook + helpers, React optional peer)
 *
 * Each entry emits .mjs, .cjs and .d.ts. React/react-dom are externalized so
 * the vanilla bundle pulls in zero React.
 */
export default defineBuildConfig({
  entries: ['src/index', 'src/react'],
  outDir: 'dist',
  clean: true,
  declaration: true,
  failOnWarn: false,
  externals: ['react', 'react-dom'],
  rollup: {
    emitCJS: true,
    esbuild: {
      jsx: 'automatic',
      target: 'es2020',
    },
  },
})
