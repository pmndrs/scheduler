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
 * Registration waits for a root to be available:
 * - If a root is already registered (or the scheduler is in `independent` mode), the
 *   job registers immediately.
 * - Otherwise it waits for the first root via `scheduler.onRootReady`.
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
 * // Independent mode - no host renderer needed
 * getScheduler().independent = true
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

    const register = () =>
      scheduler.register((state, delta) => callbackRef.current?.(state as T & FrameTimingState, delta), {
        id,
        ...options,
      })

    // Independent mode or a root already exists: register now
    if (scheduler.independent || scheduler.isReady) {
      return register()
    }

    // Wait for a root to register
    let unregisterJob: (() => void) | null = null
    const unsubReady = scheduler.onRootReady(() => {
      unregisterJob = register()
    })

    return () => {
      unsubReady()
      unregisterJob?.()
    }
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
