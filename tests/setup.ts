/**
 * Test setup for @pmndrs/scheduler
 *
 * - Mocks import.meta.hot (the scheduler reads it for HMR support)
 * - Flags the React act environment for hook tests
 */

// The scheduler uses import.meta.hot for HMR support. During build, unbuild
// transforms this to import_meta_hot. In tests there is no bundler transform,
// so we define it as undefined.
// @ts-ignore - defining import.meta shim for the test environment
globalThis.import_meta_hot = undefined

// Let React know we're testing effectful components
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
