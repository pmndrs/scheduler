//* Fixed-timestep phases ==============================
// @see docs/superpowers/specs/2026-09-26-fixed-timestep-design.md
//
// `physics` is fixed at 1/60 by default. Everything here runs on
// frameloop='never' with explicit timestamps, so each sequence of substep
// counts is exact and repeatable.

import { Scheduler } from '../src/core/scheduler'

const FRAME_60 = 1000 / 60
const DT_60 = 1 / 60

/** Deterministic PRNG so the jitter tests are repeatable. */
const lcg = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}

/** Drive `frames` frames at a fixed interval; returns the substep count per frame. */
const driveFrames = (scheduler: Scheduler, counter: { n: number }, frames: number, intervalMs: number) => {
  const perFrame: number[] = []
  for (let i = 0; i <= frames; i++) {
    counter.n = 0
    scheduler.step(i * intervalMs)
    perFrame.push(counter.n)
  }
  return perFrame.slice(1) // frame 0 has a zero delta by design
}

const createRafController = () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  return {
    flush(timestamp: number) {
      const queued = [...callbacks.values()]
      callbacks.clear()
      for (const callback of queued) callback(timestamp)
    },
  }
}

describe('fixed-timestep phases', () => {
  let scheduler: Scheduler
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Scheduler.reset()
    scheduler = Scheduler.get()
    scheduler.frameloop = 'never'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllGlobals()
    Scheduler.reset()
  })

  //* Defaults --------------------------------

  describe('defaults', () => {
    it('makes physics a fixed phase at 1/60 and every other default phase per-frame', () => {
      expect(scheduler.getPhaseTimestep('physics')).toBe(DT_60)
      for (const phase of ['start', 'input', 'update', 'render', 'finish']) {
        expect(scheduler.getPhaseTimestep(phase)).toBeUndefined()
      }
    })

    it('hands a physics job exactly 1/60 as both delta argument and state.delta', () => {
      const deltas: number[] = []
      const stateDeltas: number[] = []
      scheduler.register(
        (state, delta) => {
          deltas.push(delta)
          stateDeltas.push(state.delta)
        },
        { phase: 'physics' },
      )

      // Jittered frames so the root delta is never exactly one step.
      const rand = lcg(1)
      let t = 0
      for (let i = 0; i < 200; i++) {
        t += 10 + rand() * 30
        scheduler.step(t)
      }

      expect(deltas.length).toBeGreaterThan(100)
      for (const d of deltas) expect(d).toBe(DT_60)
      for (const d of stateDeltas) expect(d).toBe(DT_60)
    })

    it('leaves update jobs on the root delta', () => {
      const deltas: number[] = []
      scheduler.register((_s, d) => deltas.push(d))
      scheduler.step(0)
      scheduler.step(20)
      expect(deltas).toEqual([0, 0.02])
    })
  })

  //* Exactness and conservation --------------------------------

  describe('exactness and conservation', () => {
    it('runs exactly one substep per frame when the driver interval equals the timestep (60Hz)', () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics' })

      // RAF-like timestamps: multiples of 16.666… with float rounding
      const perFrame = driveFrames(scheduler, counter, 600, FRAME_60)

      expect(perFrame.every((n) => n === 1)).toBe(true)
    })

    it('runs exactly two substeps per frame at 30Hz', () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics' })

      const perFrame = driveFrames(scheduler, counter, 300, 1000 / 30)

      expect(perFrame.every((n) => n === 2)).toBe(true)
    })

    it('averages 24 substeps per second at 60Hz with a 1/24 timestep, in a 0/1-per-frame pattern', () => {
      const counter = { n: 0 }
      scheduler.setPhaseTimestep('physics', 1 / 24)
      scheduler.register(() => counter.n++, { phase: 'physics' })

      const perFrame = driveFrames(scheduler, counter, 600, FRAME_60) // 10 s

      const total = perFrame.reduce((a, b) => a + b, 0)
      expect(total).toBeGreaterThanOrEqual(239)
      expect(total).toBeLessThanOrEqual(241)
      expect(perFrame.every((n) => n === 0 || n === 1)).toBe(true)
      // A step is 2.5 frames, so two skipped frames in a row is normal and three
      // is never: any three consecutive frames contain at least one substep.
      for (let i = 2; i < perFrame.length; i++) {
        expect(perFrame[i - 2] + perFrame[i - 1] + perFrame[i]).toBeGreaterThanOrEqual(1)
      }
    })

    it('conserves time over 100k jittered frames: substeps × dt = elapsed − remainder, remainder < dt', () => {
      let invocations = 0
      let lastElapsed = 0
      scheduler.register(
        (state) => {
          invocations++
          lastElapsed = state.elapsed
        },
        { phase: 'physics' },
      )

      const rand = lcg(42)
      let t = 0
      scheduler.step(t)
      let minOverstep = Infinity
      let maxOverstep = -Infinity
      for (let i = 0; i < 100_000; i++) {
        t += 8 + rand() * 32 // 8–40 ms, at most 3 substeps per frame
        scheduler.step(t)
        const overstep = scheduler.getOverstep('physics')
        minOverstep = Math.min(minOverstep, overstep)
        maxOverstep = Math.max(maxOverstep, overstep)
      }

      const elapsedSeconds = t / 1000
      const simulated = invocations * DT_60
      const remainder = elapsedSeconds - simulated
      expect(remainder).toBeGreaterThanOrEqual(-1e-6)
      expect(remainder).toBeLessThan(DT_60)
      expect(scheduler.getOverstep('physics')).toBeCloseTo(remainder / DT_60, 6)
      expect(lastElapsed).toBeCloseTo(simulated, 9)
      expect(minOverstep).toBeGreaterThanOrEqual(0)
      expect(maxOverstep).toBeLessThan(1)
    })

    it('catches up a single slow frame with several substeps', () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      expect(counter.n).toBe(1)

      counter.n = 0
      scheduler.step(FRAME_60 + 100) // one 100ms frame
      expect(counter.n).toBe(6)
    })

    it('is deterministic: identical timestamps give identical per-frame counts', () => {
      const run = () => {
        Scheduler.reset()
        const s = Scheduler.get()
        s.frameloop = 'never'
        s.setPhaseTimestep('physics', 1 / 50)
        const counter = { n: 0 }
        s.register(() => counter.n++, { phase: 'physics' })
        const rand = lcg(7)
        const counts: number[] = []
        let t = 0
        for (let i = 0; i < 2000; i++) {
          t += 5 + rand() * 40
          counter.n = 0
          s.step(t)
          counts.push(counter.n)
        }
        return counts
      }

      expect(run()).toEqual(run())
      expect(run().some((n) => n > 1)).toBe(true) // the sequence actually exercises catch-up
    })
  })

  //* Substep semantics --------------------------------

  describe('substep semantics', () => {
    it('interleaves the jobs of a fixed phase per substep, in job order (A B, A B), not A A, B B', () => {
      const order: string[] = []
      scheduler.register(() => order.push('A'), { id: 'A', phase: 'physics', priority: 1 })
      scheduler.register(() => order.push('B'), { id: 'B', phase: 'physics', priority: 0 })

      scheduler.step(0)
      scheduler.step(3 * FRAME_60) // three substeps owed
      expect(order).toEqual(['A', 'B', 'A', 'B', 'A', 'B'])
    })

    it('runs the whole fixed phase in its slot in phase order, and before/after slots once per frame', () => {
      const order: string[] = []
      scheduler.register(() => order.push('input'), { phase: 'input' })
      scheduler.register(() => order.push('pre'), { before: 'physics' })
      scheduler.register(() => order.push('physics'), { phase: 'physics' })
      scheduler.register(() => order.push('post'), { after: 'physics' })
      scheduler.register(() => order.push('render'), { phase: 'render' })

      scheduler.step(0)
      order.length = 0
      scheduler.step(2 * FRAME_60) // two substeps
      expect(order).toEqual(['input', 'pre', 'physics', 'physics', 'post', 'render'])
    })

    it("advances state.elapsed per substep as the phase's simulated time, not the root's", () => {
      const seen: Array<{ elapsed: number; rootElapsed: number }> = []
      let rootElapsed = 0
      scheduler.register((state) => void (rootElapsed = state.elapsed), { phase: 'start' })
      scheduler.register((state) => seen.push({ elapsed: state.elapsed, rootElapsed }), { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(50) // 3 substeps banked from a 50ms root delta
      expect(seen.map((s) => s.elapsed)).toEqual([1 * DT_60, 2 * DT_60, 3 * DT_60])
      expect(seen[0].rootElapsed).toBeCloseTo(0.05, 9)
    })

    it('keeps time and frame as the driver values inside substeps', () => {
      const seen: Array<[number, number]> = []
      scheduler.register((state) => seen.push([state.time, state.frame]), { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(2 * FRAME_60)
      expect(seen).toEqual([
        [2 * FRAME_60, 2],
        [2 * FRAME_60, 2],
      ])
    })

    it('reuses one state object across the substeps of a frame', () => {
      const objects = new Set<unknown>()
      scheduler.register((state) => objects.add(state), { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(3 * FRAME_60)
      expect(objects.size).toBe(1)
    })

    it('reports every throwing substep to the root handler and still runs the rest', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const errors: Error[] = []
      let calls = 0
      scheduler.registerRoot('r', { frameloop: 'never', onError: (e) => errors.push(e) })
      scheduler.register(
        () => {
          calls++
          throw new Error(`substep ${calls}`)
        },
        { rootId: 'r', phase: 'physics' },
      )

      scheduler.step(0)
      scheduler.step(3 * FRAME_60)
      expect(calls).toBe(3)
      expect(errors.map((e) => e.message)).toEqual(['substep 1', 'substep 2', 'substep 3'])
      errorSpy.mockRestore()
    })
  })

  //* Overflow --------------------------------

  describe('overflow', () => {
    it('clamps a stall to maxSubsteps (default 8) and drops the surplus instead of carrying it', () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      counter.n = 0

      scheduler.step(FRAME_60 + 1000) // a one-second stall: 60 substeps owed
      expect(counter.n).toBe(8)
      expect(scheduler.getOverstep('physics')).toBeLessThan(1)

      // Back on the clock: the next normal frame owes one substep, not 52.
      counter.n = 0
      scheduler.step(FRAME_60 + 1000 + FRAME_60)
      expect(counter.n).toBe(1)
    })

    it('honors a custom maxSubsteps', () => {
      const counter = { n: 0 }
      scheduler.setPhaseTimestep('physics', DT_60, { maxSubsteps: 3 })
      scheduler.register(() => counter.n++, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      counter.n = 0
      scheduler.step(FRAME_60 + 1000)
      expect(counter.n).toBe(3)
    })

    it('keeps the sub-step fraction across an overflow', () => {
      scheduler.setPhaseTimestep('physics', 0.02, { maxSubsteps: 2 })
      scheduler.register(() => {}, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(70) // 3.5 substeps owed → 2 run, 30ms surplus → keep 10ms
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.5, 9)
    })
  })

  //* Overstep --------------------------------

  describe('overstep', () => {
    it('reports the fraction of the next substep already banked', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.register(() => {}, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(16) // 16ms banked, no substep yet
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.8, 9)

      scheduler.step(32) // 32ms banked → one substep, 12ms left
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.6, 9)
    })

    it('is on state for every job in the root, computed before any job runs', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      const seen: Record<string, number> = {}
      for (const phase of ['start', 'physics', 'update', 'render']) {
        scheduler.register((state) => void (seen[phase] = state.overstep), { phase })
      }

      scheduler.step(0)
      scheduler.step(16)
      expect(seen.start).toBeCloseTo(0.8, 9)
      expect(seen.update).toBeCloseTo(0.8, 9)
      expect(seen.render).toBeCloseTo(0.8, 9)
      expect(seen.physics).toBeUndefined() // no substep this frame

      scheduler.step(32)
      expect(seen.start).toBeCloseTo(0.6, 9) // a start job reads this frame's value, not last frame's
      expect(seen.physics).toBeCloseTo(0.6, 9)
      expect(seen.render).toBeCloseTo(0.6, 9)
    })

    it('is 0 with no fixed phase, for an unknown phase, and before the first tick', () => {
      scheduler.register(() => {}, { id: 'j', phase: 'physics' })
      expect(scheduler.getOverstep('physics')).toBe(0)
      expect(scheduler.getOverstep('nope')).toBe(0)

      scheduler.setPhaseTimestep('physics', undefined)
      let onState = -1
      scheduler.register((state) => void (onState = state.overstep))
      scheduler.step(0)
      scheduler.step(16)
      expect(onState).toBe(0)
      expect(scheduler.getOverstep()).toBe(0)
    })

    it('state.overstep follows the first fixed phase; getOverstep reaches a second one', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.addPhase('cloth', { after: 'physics', timestep: 0.05 })
      let onState = -1
      scheduler.register((state) => void (onState = state.overstep), { phase: 'render' })

      scheduler.step(0)
      scheduler.step(30) // physics: 1 substep, 10ms left → 0.5; cloth: 30/50 → 0.6
      expect(onState).toBeCloseTo(0.5, 9)
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.5, 9)
      expect(scheduler.getOverstep('cloth')).toBeCloseTo(0.6, 9)
    })

    it('is independent per root', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.registerRoot('a', { frameloop: 'never' })
      scheduler.registerRoot('b', { frameloop: 'never' })

      scheduler.stepRoot('a', 0)
      scheduler.stepRoot('a', 16)
      scheduler.stepRoot('b', 100)
      scheduler.stepRoot('b', 106)

      expect(scheduler.getOverstep('physics', 'a')).toBeCloseTo(0.8, 9)
      expect(scheduler.getOverstep('physics', 'b')).toBeCloseTo(0.3, 9)
    })
  })

  //* Lifecycle --------------------------------

  describe('lifecycle', () => {
    it("pause() and resume() don't burst: the clock is the phase's, the job just rejoins", () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { id: 'sim', phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      scheduler.pauseJob('sim')
      scheduler.step(1000)
      scheduler.step(2000)
      scheduler.resumeJob('sim')

      counter.n = 0
      scheduler.step(2000 + FRAME_60)
      expect(counter.n).toBe(1)
    })

    it('carries the clock across ambient adoption', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(15) // 15ms banked on the ambient root
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.75, 9)

      scheduler.registerRoot('host', { getState: () => ({}) })

      counter.n = 0
      scheduler.step(30) // +15ms → one substep, 10ms left
      expect(counter.n).toBe(1)
      expect(scheduler.getOverstep('physics', 'host')).toBeCloseTo(0.5, 9)
    })

    it('feeds a waking demand root at most one capped frame, not the whole sleep', () => {
      const raf = createRafController()
      Scheduler.reset()
      scheduler = Scheduler.get()
      scheduler.setPhaseTimestep('physics', 0.01)
      const counter = { n: 0 }

      scheduler.registerRoot('always', { frameloop: 'always' })
      scheduler.registerRoot('demand', { frameloop: 'demand' })
      scheduler.register(() => {}, { rootId: 'always' })
      scheduler.register(() => counter.n++, { rootId: 'demand', phase: 'physics' })

      scheduler.invalidateRoot('demand')
      raf.flush(1000)
      for (let frame = 1; frame <= 30; frame++) raf.flush(1000 + frame * 16)

      counter.n = 0
      scheduler.invalidateRoot('demand')
      raf.flush(1000 + 31 * 16) // 496ms since the demand root last ran
      expect(counter.n).toBe(1) // capped to one 16ms driver frame → one 10ms substep
    })

    it('is bounded by maxSubsteps on a maxDelta: Infinity root after a long gap', () => {
      const counter = { n: 0 }
      scheduler.registerRoot('sim', { frameloop: 'never', maxDelta: Infinity })
      scheduler.register(() => counter.n++, { rootId: 'sim', phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      counter.n = 0
      scheduler.step(FRAME_60 + 5000)
      expect(counter.n).toBe(8)
    })

    it('stepJob runs one substep with delta = timestep and the current simulated elapsed, leaving the clock alone', () => {
      const seen: Array<[number, number]> = []
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.register((state, d) => seen.push([d, state.elapsed]), { id: 'sim', phase: 'physics' })

      scheduler.step(0)
      scheduler.step(36) // one substep (elapsed 0.02), 16ms banked
      const before = scheduler.getOverstep('physics')

      scheduler.stepJob('sim', 500)
      expect(seen.at(-1)).toEqual([0.02, 0.02])
      expect(scheduler.getOverstep('physics')).toBe(before)
    })

    it('resetTiming() clears the clocks', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.register(() => {}, { phase: 'physics' })
      scheduler.step(0)
      scheduler.step(16)
      scheduler.resetTiming()
      expect(scheduler.getOverstep('physics')).toBe(0)
    })

    it('advances the clock even while the fixed phase has no jobs', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      let onState = -1
      scheduler.register((state) => void (onState = state.overstep), { phase: 'render' })
      scheduler.step(0)
      scheduler.step(16)
      expect(onState).toBeCloseTo(0.8, 9)
    })
  })

  //* Configuration --------------------------------

  describe('configuration', () => {
    it('setPhaseTimestep changes the rate and resets the clock on every root', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      const deltas: number[] = []
      scheduler.register((_s, d) => deltas.push(d), { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(15) // 15ms banked
      scheduler.setPhaseTimestep('physics', 0.01)
      expect(scheduler.getOverstep('physics')).toBe(0)

      scheduler.step(20) // +5ms: without the reset this would be two 10ms substeps
      expect(deltas).toEqual([])
      scheduler.step(31)
      expect(deltas).toEqual([0.01])
    })

    it('setPhaseTimestep(name, undefined) returns a phase to per-frame', () => {
      const deltas: number[] = []
      scheduler.register((_s, d) => deltas.push(d), { phase: 'physics' })
      scheduler.setPhaseTimestep('physics', undefined)

      scheduler.step(0)
      scheduler.step(20)
      expect(deltas).toEqual([0, 0.02])
      expect(scheduler.getPhaseTimestep('physics')).toBeUndefined()
    })

    it('setPhaseTimestep with the same value is a no-op that keeps the clock', () => {
      scheduler.setPhaseTimestep('physics', 0.02)
      scheduler.register(() => {}, { phase: 'physics' })
      scheduler.step(0)
      scheduler.step(16)
      scheduler.setPhaseTimestep('physics', 0.02)
      expect(scheduler.getOverstep('physics')).toBeCloseTo(0.8, 9)
    })

    it('addPhase can create a second fixed phase', () => {
      const deltas: number[] = []
      scheduler.addPhase('cloth', { after: 'physics', timestep: 0.05, maxSubsteps: 2 })
      scheduler.register((_s, d) => deltas.push(d), { phase: 'cloth' })

      expect(scheduler.phases).toEqual(['start', 'input', 'physics', 'cloth', 'update', 'render', 'finish'])
      scheduler.step(0)
      scheduler.step(500)
      expect(deltas).toEqual([0.05, 0.05]) // 10 owed, capped at 2
    })

    it.each([0, -1, NaN, Infinity])('warns on timestep=%s and leaves the phase per-frame', (bad) => {
      scheduler.addPhase('bad', { timestep: bad })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timestep must be a positive number'))
      expect(scheduler.getPhaseTimestep('bad')).toBeUndefined()

      const deltas: number[] = []
      scheduler.register((_s, d) => deltas.push(d), { phase: 'bad' })
      scheduler.step(0)
      scheduler.step(20)
      expect(deltas).toEqual([0, 0.02])
    })

    it.each([0, 2.5, NaN])('warns on maxSubsteps=%s and uses the default of 8', (bad) => {
      const counter = { n: 0 }
      scheduler.setPhaseTimestep('physics', DT_60, { maxSubsteps: bad })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxSubsteps must be a positive integer'))
      scheduler.register(() => counter.n++, { phase: 'physics' })

      scheduler.step(0)
      scheduler.step(FRAME_60)
      counter.n = 0
      scheduler.step(FRAME_60 + 1000)
      expect(counter.n).toBe(8)
    })

    it('warns on an unknown phase', () => {
      scheduler.setPhaseTimestep('nope', 0.02)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Phase "nope" not found'))
    })

    it('warns when a job in a fixed phase sets fps, and runs it every substep', () => {
      const counter = { n: 0 }
      scheduler.register(() => counter.n++, { phase: 'physics', fps: 10 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fps is ignored in the fixed phase "physics"'))

      const perFrame = driveFrames(scheduler, counter, 60, FRAME_60)
      expect(perFrame.every((n) => n === 1)).toBe(true) // not throttled to 10
    })

    it('warns when updateJob moves an fps job into a fixed phase', () => {
      scheduler.register(() => {}, { id: 'j', fps: 10 })
      expect(warn).not.toHaveBeenCalled()
      scheduler.updateJob('j', { phase: 'physics' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fps is ignored'))
    })

    it('leaves fps-throttled and per-frame jobs in other phases untouched', () => {
      const throttled = { n: 0 }
      const plain = { n: 0 }
      scheduler.register(() => throttled.n++, { fps: 30 })
      scheduler.register(() => plain.n++, {})

      for (let i = 0; i <= 60; i++) scheduler.step(i * FRAME_60)

      expect(plain.n).toBe(61)
      expect(throttled.n).toBeGreaterThanOrEqual(30)
      expect(throttled.n).toBeLessThanOrEqual(32)
    })
  })
})
