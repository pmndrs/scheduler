import * as React from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { Scheduler } from '../src/core/scheduler'
import { useFrame } from '../src/hooks/useFrame'

beforeEach(() => {
  Scheduler.reset()
  // Run without a host renderer; drive frames manually. No setup needed — the
  // first useFrame lazily creates the ambient root.
  Scheduler.get().frameloop = 'never'
})

afterEach(() => {
  cleanup()
  Scheduler.reset()
})

describe('useFrame', () => {
  it('registers a job that runs on step and unregisters on unmount', () => {
    const scheduler = Scheduler.get()
    const calls: number[] = []

    function Runner() {
      useFrame((state) => {
        calls.push(state.frame)
      })
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner />)
    })

    expect(scheduler.getJobCount()).toBe(1)

    act(() => {
      scheduler.step(1000)
    })
    expect(calls.length).toBe(1)

    act(() => {
      view.unmount()
    })

    expect(scheduler.getJobCount()).toBe(0)
  })

  it('passes timing state (time, delta, elapsed, frame) to the callback', () => {
    const scheduler = Scheduler.get()
    let received: any

    function Runner() {
      useFrame((state) => {
        received = state
      })
      return null
    }

    act(() => {
      render(<Runner />)
    })

    act(() => {
      scheduler.step(1000)
    })

    expect(received).toHaveProperty('time')
    expect(received).toHaveProperty('delta')
    expect(received).toHaveProperty('elapsed')
    expect(received).toHaveProperty('frame')
  })

  it('respects an explicit id', () => {
    const scheduler = Scheduler.get()

    function Runner() {
      useFrame(() => {}, { id: 'my-job' })
      return null
    }

    act(() => {
      render(<Runner />)
    })

    expect(scheduler.getJobIds()).toContain('my-job')
  })

  it('exposes reactive isPaused through controls and pause()/resume()', () => {
    const states: boolean[] = []

    function Runner() {
      const controls = useFrame(() => {}, { id: 'pausable' })
      states.push(controls.isPaused)
      ;(globalThis as any).__controls = controls
      return null
    }

    act(() => {
      render(<Runner />)
    })

    expect(states.at(-1)).toBe(false)

    act(() => {
      ;(globalThis as any).__controls.pause()
    })
    expect(states.at(-1)).toBe(true)

    act(() => {
      ;(globalThis as any).__controls.resume()
    })
    expect(states.at(-1)).toBe(false)

    delete (globalThis as any).__controls
  })

  it('maps a numeric second argument to priority', () => {
    const scheduler = Scheduler.get()
    const order: string[] = []

    function Runner() {
      useFrame(() => order.push('low'), { id: 'low', priority: 0 })
      useFrame(() => order.push('high'), { id: 'high', priority: 10 })
      return null
    }

    act(() => {
      render(<Runner />)
    })

    act(() => {
      scheduler.step(1000)
    })

    // Higher priority runs first within the same (default 'update') phase
    expect(order).toEqual(['high', 'low'])
  })

  it('returns scheduler access even without a callback', () => {
    let controls: any

    function Runner() {
      controls = useFrame()
      return null
    }

    act(() => {
      render(<Runner />)
    })

    expect(controls.scheduler).toBe(Scheduler.get())
    // No callback => no job registered
    expect(Scheduler.get().getJobCount()).toBe(0)
  })
})

//* Ambient root & host adoption ==============================
// @see docs/design/ambient-root.md

describe('useFrame — ambient & adoption', () => {
  beforeEach(() => {
    Scheduler.reset()
    Scheduler.get().frameloop = 'never'
  })

  it('registers and runs with no host and no setup', () => {
    const scheduler = Scheduler.get()
    const calls: number[] = []

    function Runner() {
      useFrame((state) => calls.push(state.frame))
      return null
    }

    act(() => {
      render(<Runner />)
    })

    expect(scheduler.getJobCount()).toBe(1)
    act(() => scheduler.step(1000))
    expect(calls.length).toBe(1)
  })

  it('adopts a job registered before its host and delivers host state', () => {
    const scheduler = Scheduler.get()
    const cameras: any[] = []

    function Runner() {
      // Mounts with no host yet — lands on the ambient root (simulates a child
      // useFrame effect firing before the host's registration).
      useFrame((state: any) => cameras.push(state.camera))
      return null
    }

    act(() => {
      render(<Runner />)
    })

    // Before host: timing-only state
    act(() => scheduler.step(1000))
    expect(cameras[cameras.length - 1]).toBeUndefined()

    // Host registers and adopts the in-flight job
    act(() => {
      scheduler.registerRoot('host', { getState: () => ({ camera: 'cam' }) })
    })

    act(() => scheduler.step(2000))
    expect(cameras[cameras.length - 1]).toBe('cam')

    // Still exactly one job, now on the host (ambient gone)
    expect(scheduler.getJobCount()).toBe(1)
    expect(scheduler.getRootCount()).toBe(1)
  })

  it('keeps isPaused reactivity intact across adoption', () => {
    const scheduler = Scheduler.get()

    function Runner() {
      const controls = useFrame(() => {}, { id: 'pausable' })
      return <span>{String(controls.isPaused)}</span>
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner />)
    })
    expect(view!.container.textContent).toBe('false')

    // Adopt the job into a host
    act(() => {
      scheduler.registerRoot('host', { getState: () => ({}) })
    })

    // Pausing still drives a reactive re-render after migration
    act(() => {
      scheduler.pauseJob('pausable')
    })
    expect(view!.container.textContent).toBe('true')
  })
})
