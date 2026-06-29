import * as React from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { Scheduler } from '../src/core/scheduler'
import { useFrame } from '../src/hooks/useFrame'

beforeEach(() => {
  Scheduler.reset()
  const scheduler = Scheduler.get()
  // Run without a host renderer; drive frames manually.
  scheduler.independent = true
  scheduler.frameloop = 'never'
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
