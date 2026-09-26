/**
 * Test setup for @pmndrs/scheduler
 *
 * - Flags the React act environment for hook tests
 */

// Let React know we're testing effectful components
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
