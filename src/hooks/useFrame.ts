//* useFrame Hook ==============================

import * as React from 'react'
import { useMutableCallback, useIsomorphicLayoutEffect } from './utils'
import { getScheduler, type Scheduler } from '../core/scheduler'

//* Type Imports ==============================
import type { FrameCallback, FrameTimingState, UseFrameOptions, FrameControls } from '../types'

/**
 * Framework-agnostic frame hook with phase-based ordering, priority, and FPS throttling.
 *
 * Registers a callback with the global {@link Scheduler}. By default the callback
 * receives timing-only state (`time`, `delta`, `elapsed`, `frame`). Renderers that
 * inject their own state through a root's `getState` can type it via the generic:
 * `useFrame<MyState>((state, delta) => ...)`.
 *
 * Registration is immediate and needs no setup: if no host has registered, the
 * job attaches to the scheduler's lazily-created ambient root. If a host (e.g. a
 * `<Canvas>`) registers later — React fires child effects before the parent's —
 * it adopts the job. @see docs/design/ambient-root.md
 *
 * Returns a controls object for manual stepping, pausing, and resuming.
 *
 * @param callback - Function called each frame with (state, delta). Optional if you only need scheduler access.
 * @param priorityOrOptions - Either a priority number (shorthand for `{ priority }`) or an options object
 * @returns Controls object with step(), stepAll(), pause(), resume(), isPaused, id, scheduler
 *
 * @example
 * // Phase-based ordering
 * useFrame((state, delta) => { ... }, { phase: 'physics' })
 *
 * @example
 * // Standalone - no host renderer needed, no setup
 * useFrame((state, delta) => { updateGame(delta) })
 *
 * @example
 * // Scheduler-only access (no callback)
 * const { scheduler } = useFrame()
 * scheduler.pauseJob('some-job-id')
 */
export function useFrame<T = FrameTimingState>(
  callback?: FrameCallback<T>,
  priorityOrOptions?: number | UseFrameOptions,
): FrameControls {
  const scheduler = getScheduler()

  // Compute stable key from option VALUES (not reference).
  // Runs every render but is cheap - avoids inline object reference issues.
  const optionsKey =
    typeof priorityOrOptions === 'number'
      ? `p:${priorityOrOptions}`
      : priorityOrOptions
        ? JSON.stringify({
            id: priorityOrOptions.id,
            phase: priorityOrOptions.phase,
            priority: priorityOrOptions.priority,
            fps: priorityOrOptions.fps,
            drop: priorityOrOptions.drop,
            enabled: priorityOrOptions.enabled,
            before: priorityOrOptions.before,
            after: priorityOrOptions.after,
          })
        : ''

  // Memoize options object using the stable key
  const options: UseFrameOptions = React.useMemo(() => {
    return typeof priorityOrOptions === 'number' ? { priority: priorityOrOptions } : (priorityOrOptions ?? {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey])

  // Generate stable ID if not provided
  const reactId = React.useId()
  const id = options.id ?? reactId

  // Memoize callback ref (always points to latest callback)
  const callbackRef = useMutableCallback(callback)

  // Subscribe on mount, unsubscribe on unmount (only if callback provided)
  useIsomorphicLayoutEffect(() => {
    // Skip registration if no callback - user just wants scheduler access
    if (!callback) return

    // Register immediately. Under the ambient-root model the scheduler always has
    // a root to attach to (the ambient root is created lazily here if none
    // exists). If this effect runs before a host's — React fires child effects
    // before parent — the host adopts this job when it registers. No waiting.
    // @see docs/design/ambient-root.md
    return scheduler.register((state, delta) => callbackRef.current?.(state as T & FrameTimingState, delta), {
      id,
      ...options,
    })
    // Note: `callback` intentionally excluded - useMutableCallback handles updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler, id, optionsKey])

  // Reactive isPaused via useSyncExternalStore --------------------------------
  const isPaused = React.useSyncExternalStore(
    React.useCallback((onStoreChange: () => void) => getScheduler().subscribeJobState(id, onStoreChange), [id]),
    React.useCallback(() => getScheduler().isJobPaused(id), [id]),
    React.useCallback(() => false, []),
  )

  // Build controls object (memoized to maintain stable reference)
  const controls = React.useMemo<FrameControls>(() => {
    const scheduler = getScheduler()

    return {
      /** The job's unique ID */
      id,
      /** Access to the global scheduler for frame loop control */
      scheduler: scheduler as Scheduler,
      /** Manually step this job only (bypasses FPS limiting) */
      step: (timestamp?: number) => {
        getScheduler().stepJob(id, timestamp)
      },
      /** Manually step ALL jobs in the scheduler (useful for frameloop='never') */
      stepAll: (timestamp?: number) => {
        getScheduler().step(timestamp)
      },
      /** Pause this job (set enabled=false) */
      pause: () => {
        getScheduler().pauseJob(id)
      },
      /** Resume this job (set enabled=true) */
      resume: () => {
        getScheduler().resumeJob(id)
      },
      /** Reactive paused state - automatically updates when pause/resume is called */
      isPaused,
    }
  }, [id, isPaused])

  return controls
}
