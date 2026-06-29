//* React Utilities ==============================
// Small, portable React helpers used by the useFrame hook.

import * as React from 'react'

/**
 * An SSR-friendly useLayoutEffect.
 *
 * React currently throws a warning when using useLayoutEffect on the server.
 * To get around it, we can conditionally useEffect on the server (no-op) and
 * useLayoutEffect elsewhere.
 *
 * @see https://github.com/facebook/react/issues/14927
 */
export const useIsomorphicLayoutEffect = /* @__PURE__ */ (() =>
  typeof window !== 'undefined' && (window.document?.createElement || window.navigator?.product === 'ReactNative'))()
  ? React.useLayoutEffect
  : React.useEffect

/**
 * Creates a stable ref that always contains the latest callback.
 * Useful for avoiding dependency arrays while ensuring the latest closure is called.
 *
 * @param fn - The callback function to wrap
 * @returns A ref containing the current callback
 */
export function useMutableCallback<T>(fn: T): React.RefObject<T> {
  const ref = React.useRef<T>(fn)
  useIsomorphicLayoutEffect(() => void (ref.current = fn), [fn])
  return ref
}
