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

//* Root-scoped Controls ==============================
// A job needs a way to wake its OWN root without waking every sibling.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('useFrame root-scoped controls', () => {
  it('reports the owning root and survives host adoption', () => {
    const scheduler = Scheduler.get()
    let controls: ReturnType<typeof useFrame> | undefined

    function Runner() {
      controls = useFrame(() => {})
      return null
    }

    act(() => {
      render(<Runner />)
    })

    // Registered before any host: the job sits on the ambient root.
    expect(controls!.rootId).toBe(Scheduler.AMBIENT_ID)

    act(() => {
      scheduler.registerRoot('host')
    })

    // rootId is resolved on access, so adoption is reflected without a re-render.
    expect(controls!.rootId).toBe('host')
  })

  it('invalidates only the root that owns the job', () => {
    // Drive the RAF path, not step(): step() runs every root regardless of
    // pending frames, so it can't distinguish targeted from global invalidation.
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const handle = nextId++
      frames.set(handle, cb)
      return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle))

    try {
      const scheduler = Scheduler.get()
      const calls: string[] = []
      let controls: ReturnType<typeof useFrame> | undefined

      scheduler.registerRoot('mine', { frameloop: 'demand' })
      scheduler.registerRoot('other', { frameloop: 'demand' })
      scheduler.register(() => calls.push('other'), { rootId: 'other' })

      function Runner() {
        controls = useFrame(() => calls.push('mine'), { id: 'mine-job' })
        return null
      }

      act(() => {
        render(<Runner />)
      })
      // No rootId option on the hook: a job defaults to the first registered root.
      // Asserted rather than assumed, so the test's premise can't silently rot.
      expect(controls!.rootId).toBe('mine')

      act(() => {
        controls!.invalidate()
      })

      act(() => {
        const queued = [...frames.values()]
        frames.clear()
        for (const cb of queued) cb(1000)
      })

      // The sibling demand root stayed asleep.
      expect(calls).toEqual(['mine'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('useFrame audit regressions', () => {
  it('registers when a callback appears after mounting without one', () => {
    const scheduler = Scheduler.get()
    const calls = vi.fn()

    function Runner({ active }: { active: boolean }) {
      useFrame(active ? calls : undefined)
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner active={false} />)
    })
    expect(scheduler.getJobCount()).toBe(0)

    // Presence used to be read once inside the effect, so this never registered.
    act(() => {
      view.rerender(<Runner active={true} />)
    })
    expect(scheduler.getJobCount()).toBe(1)

    act(() => {
      scheduler.step(1000)
    })
    expect(calls).toHaveBeenCalledTimes(1)

    act(() => {
      view.rerender(<Runner active={false} />)
    })
    expect(scheduler.getJobCount()).toBe(0)
  })
})

describe('useFrame stable jobs', () => {
  it('keeps its ordering slot and id when options change', () => {
    const scheduler = Scheduler.get()
    const order: string[] = []
    let capturedId = ''

    function First({ fps }: { fps?: number }) {
      const controls = useFrame(() => order.push('first'), { fps })
      capturedId = controls.id
      return null
    }
    function Second() {
      useFrame(() => order.push('second'))
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(
        <>
          <First />
          <Second />
        </>,
      )
    })
    const idBefore = capturedId
    act(() => scheduler.step(1000))
    expect(order).toEqual(['first', 'second'])

    // Re-registering used to move `first` behind `second` (new insertion index).
    order.length = 0
    act(() => {
      view.rerender(
        <>
          <First fps={120} />
          <Second />
        </>,
      )
    })
    act(() => scheduler.step(2000))
    expect(order).toEqual(['first', 'second'])
    expect(capturedId).toBe(idBefore)
    expect(scheduler.getJobCount()).toBe(2)
  })

  it('does not undo an imperative pause() when an unrelated option changes', () => {
    const scheduler = Scheduler.get()
    const cb = vi.fn()
    let controls: any

    function Runner({ priority }: { priority: number }) {
      controls = useFrame(cb, { priority })
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner priority={0} />)
    })
    act(() => controls.pause())
    expect(controls.isPaused).toBe(true)

    act(() => {
      view.rerender(<Runner priority={5} />)
    })
    expect(controls.isPaused).toBe(true)
    act(() => scheduler.step(1000))
    expect(cb).not.toHaveBeenCalled()
  })

  it('keeps isPaused reactive after an option change', () => {
    const states: boolean[] = []
    let controls: any

    function Runner({ fps }: { fps?: number }) {
      controls = useFrame(() => {}, { fps })
      states.push(controls.isPaused)
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner />)
    })
    act(() => {
      view.rerender(<Runner fps={30} />)
    })
    act(() => controls.pause())
    expect(states.at(-1)).toBe(true)
    act(() => controls.resume())
    expect(states.at(-1)).toBe(false)
  })

  it('removing an option resets it to the default', () => {
    const scheduler = Scheduler.get()
    const cb = vi.fn()

    function Runner({ enabled }: { enabled?: boolean }) {
      useFrame(cb, { enabled })
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner enabled={false} />)
    })
    act(() => scheduler.step(1000))
    expect(cb).not.toHaveBeenCalled()

    act(() => {
      view.rerender(<Runner />) // enabled omitted → default true
    })
    act(() => scheduler.step(2000))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('re-registers when the explicit id changes', () => {
    const scheduler = Scheduler.get()

    function Runner({ id }: { id: string }) {
      useFrame(() => {}, { id })
      return null
    }

    let view: ReturnType<typeof render>
    act(() => {
      view = render(<Runner id="one" />)
    })
    expect(scheduler.getJobIds()).toEqual(['one'])
    act(() => {
      view.rerender(<Runner id="two" />)
    })
    expect(scheduler.getJobIds()).toEqual(['two'])
  })

  it('gives components in separate React roots distinct auto ids', () => {
    const scheduler = Scheduler.get()

    function Runner() {
      useFrame(() => {})
      return null
    }

    act(() => {
      render(<Runner />)
      render(<Runner />) // a second React root with an identical tree
    })

    const ids = scheduler.getJobIds()
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})
