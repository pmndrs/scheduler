import { Scheduler } from '../src/core/scheduler'
import { PhaseGraph } from '../src/core/phaseGraph'
import { rebuildSortedJobs } from '../src/core/sorter'
import { shouldRun } from '../src/core/rateLimiter'
import type { Job } from '../src/types'

//* Deterministic RAF Controller ==============================

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
    get size() {
      return callbacks.size
    },
  }
}

//* Cross-Bundle Singleton ==============================
// Mixing imports from different bundles must yield ONE scheduler instance.
// This is guaranteed by the Symbol.for('@pmndrs/scheduler') global key.

describe('cross-bundle singleton', () => {
  beforeEach(() => {
    delete (globalThis as any)[Symbol.for('@pmndrs/scheduler')]
  })

  afterEach(() => {
    Scheduler.reset()
  })

  it('shares one instance across module reloads', async () => {
    vi.resetModules()
    const modA = await import('../src/core/scheduler')
    const a = modA.getScheduler()

    vi.resetModules()
    const modB = await import('../src/core/scheduler')
    const b = modB.getScheduler()

    expect(a).toBe(b)
  })

  it('maintains state across module reloads', async () => {
    vi.resetModules()
    const modA = await import('../src/core/scheduler')
    const rootId = modA.getScheduler().generateRootId()

    vi.resetModules()
    const modB = await import('../src/core/scheduler')
    const nextRootId = modB.getScheduler().generateRootId()

    // Same instance => sequential IDs
    expect(nextRootId).not.toBe(rootId)
  })
})

//* PhaseGraph Tests ==============================

describe('PhaseGraph', () => {
  it('initializes with default phases', () => {
    const graph = new PhaseGraph()
    const phases = graph.getOrderedPhases()

    expect(phases).toEqual(['start', 'input', 'physics', 'update', 'render', 'finish'])
  })

  it('adds phase before another phase', () => {
    const graph = new PhaseGraph()
    graph.addPhase('clouds', { before: 'render' })
    const phases = graph.getOrderedPhases()

    expect(phases).toEqual(['start', 'input', 'physics', 'update', 'clouds', 'render', 'finish'])
  })

  it('adds phase after another phase', () => {
    const graph = new PhaseGraph()
    graph.addPhase('postFx', { after: 'render' })
    const phases = graph.getOrderedPhases()

    expect(phases).toEqual(['start', 'input', 'physics', 'update', 'render', 'postFx', 'finish'])
  })

  it('prevents duplicate phases', () => {
    const graph = new PhaseGraph()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    graph.addPhase('update', { before: 'render' })

    expect(warnSpy).toHaveBeenCalledWith('[useFrame] Phase "update" already exists')
    expect(graph.getOrderedPhases().filter((p) => p === 'update').length).toBe(1)

    warnSpy.mockRestore()
  })

  it('resolves constraint phase for before constraint', () => {
    const graph = new PhaseGraph()
    const phase = graph.resolveConstraintPhase('render', undefined)

    expect(phase).toBe('before:render')
    expect(graph.hasPhase('before:render')).toBe(true)
    // Should be inserted before render
    const phases = graph.getOrderedPhases()
    const beforeIdx = phases.indexOf('before:render')
    const renderIdx = phases.indexOf('render')
    expect(beforeIdx).toBeLessThan(renderIdx)
  })

  it('resolves constraint phase for after constraint', () => {
    const graph = new PhaseGraph()
    const phase = graph.resolveConstraintPhase(undefined, 'render')

    expect(phase).toBe('after:render')
    expect(graph.hasPhase('after:render')).toBe(true)
    // Should be inserted after render
    const phases = graph.getOrderedPhases()
    const afterIdx = phases.indexOf('after:render')
    const renderIdx = phases.indexOf('render')
    expect(afterIdx).toBeGreaterThan(renderIdx)
  })

  it('returns update phase when no constraints', () => {
    const graph = new PhaseGraph()
    const phase = graph.resolveConstraintPhase(undefined, undefined)

    expect(phase).toBe('update')
  })

  it('caches ordered phases and invalidates on change', () => {
    const graph = new PhaseGraph()
    const phases1 = graph.getOrderedPhases()
    const phases2 = graph.getOrderedPhases()

    // Should be same reference (cached)
    expect(phases1).toBe(phases2)

    graph.addPhase('newPhase', { before: 'finish' })
    const phases3 = graph.getOrderedPhases()

    // Should be different reference after change
    expect(phases3).not.toBe(phases1)
    expect(phases3).toContain('newPhase')
  })
})

//* Sorter Tests ==============================

describe('rebuildSortedJobs', () => {
  const createJob = (overrides: Partial<Job>): Job => ({
    id: 'test-job',
    callback: vi.fn(),
    phase: 'update',
    before: new Set(),
    after: new Set(),
    priority: 0,
    index: 0,
    drop: true,
    enabled: true,
    ...overrides,
  })

  it('sorts jobs by phase order', () => {
    const graph = new PhaseGraph()
    const jobs = new Map<string, Job>([
      ['job-render', createJob({ id: 'job-render', phase: 'render', index: 0 })],
      ['job-physics', createJob({ id: 'job-physics', phase: 'physics', index: 1 })],
      ['job-update', createJob({ id: 'job-update', phase: 'update', index: 2 })],
    ])

    const sorted = rebuildSortedJobs(jobs, graph)

    expect(sorted.map((j) => j.id)).toEqual(['job-physics', 'job-update', 'job-render'])
  })

  it('sorts jobs by priority within phase (higher first)', () => {
    const graph = new PhaseGraph()
    const jobs = new Map<string, Job>([
      ['job-low', createJob({ id: 'job-low', phase: 'update', priority: 1, index: 0 })],
      ['job-high', createJob({ id: 'job-high', phase: 'update', priority: 10, index: 1 })],
      ['job-mid', createJob({ id: 'job-mid', phase: 'update', priority: 5, index: 2 })],
    ])

    const sorted = rebuildSortedJobs(jobs, graph)

    expect(sorted.map((j) => j.id)).toEqual(['job-high', 'job-mid', 'job-low'])
  })

  it('uses index for tie-breaking when priorities equal', () => {
    const graph = new PhaseGraph()
    const jobs = new Map<string, Job>([
      ['job-c', createJob({ id: 'job-c', phase: 'update', priority: 5, index: 2 })],
      ['job-a', createJob({ id: 'job-a', phase: 'update', priority: 5, index: 0 })],
      ['job-b', createJob({ id: 'job-b', phase: 'update', priority: 5, index: 1 })],
    ])

    const sorted = rebuildSortedJobs(jobs, graph)

    expect(sorted.map((j) => j.id)).toEqual(['job-a', 'job-b', 'job-c'])
  })

  it('excludes disabled jobs', () => {
    const graph = new PhaseGraph()
    const jobs = new Map<string, Job>([
      ['job-enabled', createJob({ id: 'job-enabled', enabled: true, index: 0 })],
      ['job-disabled', createJob({ id: 'job-disabled', enabled: false, index: 1 })],
    ])

    const sorted = rebuildSortedJobs(jobs, graph)

    expect(sorted.map((j) => j.id)).toEqual(['job-enabled'])
  })

  it('handles cross-job constraints with topological sort', () => {
    const graph = new PhaseGraph()
    const jobs = new Map<string, Job>([
      ['job-a', createJob({ id: 'job-a', phase: 'update', after: new Set(['job-b']), index: 0 })],
      ['job-b', createJob({ id: 'job-b', phase: 'update', index: 1 })],
    ])

    const sorted = rebuildSortedJobs(jobs, graph)

    // job-b should come before job-a due to constraint
    const idxA = sorted.findIndex((j) => j.id === 'job-a')
    const idxB = sorted.findIndex((j) => j.id === 'job-b')
    expect(idxB).toBeLessThan(idxA)
  })
})

//* Rate Limiter Tests ==============================

describe('shouldRun (rate limiter)', () => {
  const createJob = (overrides: Partial<Job>): Job => ({
    id: 'test-job',
    callback: vi.fn(),
    phase: 'update',
    before: new Set(),
    after: new Set(),
    priority: 0,
    index: 0,
    drop: true,
    enabled: true,
    ...overrides,
  })

  it('returns true when no FPS limit', () => {
    const job = createJob({})
    expect(shouldRun(job, 1000)).toBe(true)
  })

  it('returns false when disabled', () => {
    const job = createJob({ enabled: false })
    expect(shouldRun(job, 1000)).toBe(false)
  })

  it('returns false when not enough time has passed', () => {
    const job = createJob({ fps: 30, lastRun: 1000 })
    // 30 FPS = ~33.3ms interval, only 10ms passed
    expect(shouldRun(job, 1010)).toBe(false)
  })

  it('returns true and updates lastRun when interval passed', () => {
    const job = createJob({ fps: 30, lastRun: 1000 })
    // 30 FPS = ~33.3ms interval, 50ms passed
    const result = shouldRun(job, 1050)

    expect(result).toBe(true)
    expect(job.lastRun).toBeDefined()
  })

  it('uses drop semantics when drop=true', () => {
    const job = createJob({ fps: 30, lastRun: 1000, drop: true })
    const now = 1100 // 100ms passed (missed ~2 frames)

    shouldRun(job, now)

    // With drop=true, lastRun snaps to now
    expect(job.lastRun).toBe(now)
  })

  it('uses catch-up semantics when drop=false', () => {
    const job = createJob({ fps: 30, lastRun: 1000, drop: false })
    const now = 1100 // 100ms passed (missed ~2 frames)

    shouldRun(job, now)

    // With drop=false, lastRun advances by interval steps
    // Interval is ~33.3ms, so 3 steps = ~100ms
    expect(job.lastRun).toBeGreaterThan(1000)
    expect(job.lastRun).toBeLessThanOrEqual(now)
  })
})

//* Scheduler Tests ==============================

describe('Scheduler', () => {
  let scheduler: Scheduler
  let unregisterRoot: () => void

  // Arbitrary state object injected via getState
  const mockState = {
    scene: {},
    camera: {},
    internal: { scheduler: null },
  } as any

  beforeEach(() => {
    // Reset singleton and get fresh scheduler
    Scheduler.reset()
    scheduler = Scheduler.get()
    // Set to never mode so loop doesn't auto-start
    scheduler.frameloop = 'never'
    // Register a mock root so jobs have somewhere to live
    unregisterRoot = scheduler.registerRoot('test-root', { getState: () => mockState })
  })

  afterEach(() => {
    unregisterRoot()
    Scheduler.reset()
  })

  it('registers and unregisters jobs', () => {
    const cb = vi.fn()
    const unsubscribe = scheduler.register(cb, { id: 'test-job', rootId: 'test-root' })

    expect(scheduler.getJobCount()).toBe(1)
    expect(scheduler.getJobIds()).toContain('test-job')

    unsubscribe()

    expect(scheduler.getJobCount()).toBe(0)
  })

  it('generates IDs when not provided', () => {
    const cb = vi.fn()
    scheduler.register(cb, { rootId: 'test-root' })

    expect(scheduler.getJobCount()).toBe(1)
    expect(scheduler.getJobIds()[0]).toMatch(/^job_\d+$/)
  })

  it('exposes addPhase API', () => {
    scheduler.addPhase('custom', { before: 'render' })

    expect(scheduler.hasPhase('custom')).toBe(true)
    expect(scheduler.phases).toContain('custom')
  })

  it('starts and stops the loop', () => {
    expect(scheduler.isRunning).toBe(false)

    scheduler.start()
    expect(scheduler.isRunning).toBe(true)

    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })

  it('updates job options', () => {
    const cb = vi.fn()
    scheduler.register(cb, { id: 'test-job', rootId: 'test-root', priority: 1 })

    scheduler.updateJob('test-job', { priority: 10, enabled: false })

    // Job should be updated (we can't directly access the job, but it should not throw)
    expect(scheduler.getJobCount()).toBe(1)
  })

  it('handles duplicate IDs with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.register(vi.fn(), { id: 'dupe', rootId: 'test-root' })
    scheduler.register(vi.fn(), { id: 'dupe', rootId: 'test-root' })

    expect(warnSpy).toHaveBeenCalledWith('[useFrame] Job with id "dupe" already exists, replacing')
    expect(scheduler.getJobCount()).toBe(1)

    warnSpy.mockRestore()
  })

  it('supports manual step() for all jobs', () => {
    const calls: string[] = []

    scheduler.register(() => calls.push('job1'), { id: 'job1', rootId: 'test-root' })
    scheduler.register(() => calls.push('job2'), { id: 'job2', rootId: 'test-root' })

    // No automatic loop started
    expect(scheduler.isRunning).toBe(false)
    expect(calls.length).toBe(0)

    // Manual step
    scheduler.step()
    expect(calls).toEqual(['job1', 'job2'])

    // Step again
    scheduler.step()
    expect(calls).toEqual(['job1', 'job2', 'job1', 'job2'])
  })

  // Phase-order regression: jobs registered with { before: 'render' } must run after
  // update and before render. This also exercises job-to-job chaining inside the
  // auto-generated 'before:render' phase used by r3f system jobs.
  it('runs { before: render } jobs after update and before render', () => {
    const calls: string[] = []

    scheduler.register(() => calls.push('update'), { id: 'update-job', rootId: 'test-root', phase: 'update' })
    scheduler.register(() => calls.push('render'), { id: 'render-job', rootId: 'test-root', phase: 'render' })
    scheduler.register(() => calls.push('frustum'), { id: 'frustum', rootId: 'test-root', before: 'render' })
    scheduler.register(() => calls.push('visibility'), {
      id: 'visibility',
      rootId: 'test-root',
      before: 'render',
      after: 'frustum',
    })

    scheduler.step()

    // update precedes both checks; both checks precede render; frustum precedes visibility
    expect(calls.indexOf('update')).toBeLessThan(calls.indexOf('frustum'))
    expect(calls.indexOf('frustum')).toBeLessThan(calls.indexOf('visibility'))
    expect(calls.indexOf('visibility')).toBeLessThan(calls.indexOf('render'))
    expect(calls).toEqual(['update', 'frustum', 'visibility', 'render'])
  })

  it('supports stepJob() for a single job', () => {
    const calls: string[] = []

    scheduler.register(() => calls.push('job1'), { id: 'job1', rootId: 'test-root' })
    scheduler.register(() => calls.push('job2'), { id: 'job2', rootId: 'test-root' })

    // Step only job1
    scheduler.stepJob('job1')
    expect(calls).toEqual(['job1'])

    // Step only job2
    scheduler.stepJob('job2')
    expect(calls).toEqual(['job1', 'job2'])
  })

  it('supports pauseJob() and resumeJob()', () => {
    const calls: string[] = []

    scheduler.register(() => calls.push('job1'), { id: 'job1', rootId: 'test-root' })

    expect(scheduler.isJobPaused('job1')).toBe(false)

    scheduler.pauseJob('job1')
    expect(scheduler.isJobPaused('job1')).toBe(true)

    // Paused job should not run on step
    scheduler.step()
    expect(calls.length).toBe(0)

    scheduler.resumeJob('job1')
    expect(scheduler.isJobPaused('job1')).toBe(false)

    scheduler.step()
    expect(calls).toEqual(['job1'])
  })

  it('supports frameloop getter/setter', () => {
    // With a root registered, frameloop defaults to 'never' until set
    scheduler.frameloop = 'never'
    expect(scheduler.frameloop).toBe('never')
    expect(scheduler.isRunning).toBe(false)

    scheduler.frameloop = 'always'
    expect(scheduler.frameloop).toBe('always')
    expect(scheduler.isRunning).toBe(true)

    scheduler.frameloop = 'demand'
    expect(scheduler.frameloop).toBe('demand')
    expect(scheduler.isRunning).toBe(false)
  })

  it('supports invalidate() for demand mode', async () => {
    const calls: string[] = []

    scheduler.frameloop = 'demand'
    scheduler.register(() => calls.push('frame'), { id: 'job', rootId: 'test-root' })

    expect(calls.length).toBe(0)
    expect(scheduler.isRunning).toBe(false)

    // Invalidate should start the loop
    scheduler.invalidate()
    expect(scheduler.isRunning).toBe(true)

    // Wait for frame to execute
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(calls.length).toBeGreaterThan(0)
    // Should have stopped after running the requested frame(s)
    expect(scheduler.isRunning).toBe(false)
  })
})

//* Per-root Frameloop ==============================

describe('Scheduler per-root frameloop', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  it('keeps an always root running while a demand root sleeps', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => calls.push('always'), { rootId: 'always' })
    scheduler.register(() => calls.push('demand'), { rootId: 'demand' })

    raf.flush(1000)

    expect(calls).toEqual(['always'])
    expect(raf.size).toBe(1)
  })

  it('invalidates only the selected demand root', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => calls.push('always'), { rootId: 'always' })
    scheduler.register(() => calls.push('demand'), { rootId: 'demand' })

    raf.flush(1000)
    scheduler.invalidateRoot('demand')
    raf.flush(1016)
    raf.flush(1032)

    expect(calls).toEqual(['always', 'always', 'demand', 'always'])
    expect(raf.size).toBe(1)
  })

  it('tracks pending frames independently for each demand root', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    let firstRuns = 0
    let secondRuns = 0
    let idleCalls = 0

    scheduler.registerRoot('first', { frameloop: 'demand' })
    scheduler.registerRoot('second', { frameloop: 'demand' })
    scheduler.register(() => firstRuns++, { rootId: 'first' })
    scheduler.register(() => secondRuns++, { rootId: 'second' })
    scheduler.onIdle(() => idleCalls++)

    scheduler.invalidateRoot('first', 1)
    scheduler.invalidateRoot('second', 3)
    raf.flush(1000)
    raf.flush(1016)
    raf.flush(1032)

    expect(firstRuns).toBe(1)
    expect(secondRuns).toBe(3)
    expect(idleCalls).toBe(1)
    expect(scheduler.isRunning).toBe(false)
    expect(raf.size).toBe(0)
  })

  it('fans global invalidation out to demand roots but not never roots', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('first', { frameloop: 'demand' })
    scheduler.registerRoot('second', { frameloop: 'demand' })
    scheduler.registerRoot('manual', { frameloop: 'never' })
    scheduler.register(() => calls.push('first'), { rootId: 'first' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })
    scheduler.register(() => calls.push('manual'), { rootId: 'manual' })

    scheduler.invalidate()
    raf.flush(1000)

    expect(calls).toEqual(['first', 'second'])
    expect(raf.size).toBe(0)
  })

  it('stops only after the final always root changes to demand', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('first', { frameloop: 'always' })
    scheduler.registerRoot('second', { frameloop: 'always' })
    scheduler.register(() => calls.push('first'), { rootId: 'first' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })

    raf.flush(1000)
    scheduler.setRootFrameloop('second', 'demand')
    raf.flush(1016)

    expect(calls).toEqual(['first', 'second', 'first'])
    expect(scheduler.isRunning).toBe(true)

    scheduler.setRootFrameloop('first', 'demand')

    expect(scheduler.isRunning).toBe(false)
    expect(raf.size).toBe(0)
  })

  it('preserves invalidation requested during a demand callback', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    let runs = 0

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(
      () => {
        runs++
        if (runs === 1) scheduler.invalidateRoot('demand')
      },
      { rootId: 'demand' },
    )

    scheduler.invalidateRoot('demand')
    raf.flush(1000)

    expect(runs).toBe(1)
    expect(raf.size).toBe(1)

    raf.flush(1016)

    expect(runs).toBe(2)
    expect(raf.size).toBe(0)
  })

  it('defers sibling invalidation raised during the current frame', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(
      () => {
        calls.push('always')
        if (calls.length === 1) scheduler.invalidateRoot('demand')
      },
      { rootId: 'always' },
    )
    scheduler.register(() => calls.push('demand'), { rootId: 'demand' })

    raf.flush(1000)
    expect(calls).toEqual(['always'])

    raf.flush(1016)
    expect(calls).toEqual(['always', 'always', 'demand'])
  })

  it('supports replace, stack, and per-root frame caps', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    let runs = 0

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => runs++, { rootId: 'demand' })

    scheduler.invalidateRoot('demand', 3)
    scheduler.invalidateRoot('demand', 2, true)

    for (let frame = 0; frame < 5; frame++) raf.flush(1000 + frame * 16)

    expect(runs).toBe(5)
    expect(raf.size).toBe(0)

    scheduler.invalidateRoot('demand', 100)
    for (let frame = 0; frame < 60; frame++) raf.flush(2000 + frame * 16)

    expect(runs).toBe(65)
    expect(raf.size).toBe(0)
  })

  it('steps every root manually without consuming demand frames', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.registerRoot('manual', { frameloop: 'never' })
    scheduler.register(() => calls.push('demand'), { rootId: 'demand' })
    scheduler.register(() => calls.push('manual'), { rootId: 'manual' })

    scheduler.invalidateRoot('demand')
    scheduler.step(1000)
    raf.flush(1016)

    expect(calls).toEqual(['demand', 'manual', 'demand'])
    expect(raf.size).toBe(0)
  })

  it('lets explicit start and stop override root lifecycle selection', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.registerRoot('manual', { frameloop: 'never' })
    scheduler.register(() => calls.push('demand'), { rootId: 'demand' })
    scheduler.register(() => calls.push('manual'), { rootId: 'manual' })

    scheduler.start()
    raf.flush(1000)
    raf.flush(1016)

    expect(calls).toEqual(['demand', 'manual', 'demand', 'manual'])
    expect(raf.size).toBe(1)

    scheduler.stop()

    expect(scheduler.isRunning).toBe(false)
    expect(raf.size).toBe(0)
  })

  it('keeps the global frameloop setter as a default and fan-out control', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('first', { frameloop: 'always' })
    scheduler.registerRoot('second', { frameloop: 'demand' })
    scheduler.register(() => calls.push('first'), { rootId: 'first' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })

    scheduler.frameloop = 'never'

    expect(scheduler.frameloop).toBe('never')
    expect(scheduler.isRunning).toBe(false)
    expect(raf.size).toBe(0)

    scheduler.frameloop = 'always'
    raf.flush(1000)

    expect(calls).toEqual(['first', 'second'])

    scheduler.registerRoot('third')
    scheduler.register(() => calls.push('third'), { rootId: 'third' })
    raf.flush(1016)

    expect(calls).toEqual(['first', 'second', 'first', 'second', 'third'])
  })

  it('reconciles the host mode after ambient-root adoption', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()

    scheduler.register(() => {}, { id: 'orphan' })
    expect(scheduler.isRunning).toBe(true)

    scheduler.registerRoot('host', { frameloop: 'demand' })

    expect(scheduler.getRootCount()).toBe(1)
    expect(scheduler.isRunning).toBe(false)
    expect(raf.size).toBe(0)
  })

  it('starts an always host after adopting a sleeping ambient root', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()

    scheduler.frameloop = 'demand'
    scheduler.register(() => {}, { id: 'orphan' })
    expect(scheduler.isRunning).toBe(false)

    scheduler.registerRoot('host', { frameloop: 'always' })

    expect(scheduler.getRootCount()).toBe(1)
    expect(scheduler.isRunning).toBe(true)
    expect(raf.size).toBe(1)
  })

  it('warns and no-ops for unknown root lifecycle controls', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.setRootFrameloop('missing', 'demand')
    scheduler.invalidateRoot('missing')

    expect(warn).toHaveBeenCalledTimes(2)
    expect(scheduler.isRunning).toBe(false)

    warn.mockRestore()
  })
})

//* Standalone (hostless) State ==============================
// Lazy ambient-root behavior is covered in "Ambient root & host adoption"; this
// pins the exact shape of the timing-only state a hostless job receives.

describe('Scheduler standalone state', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
  })

  it('provides timing-only state with no host props', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    let receivedState: any
    scheduler.register((state) => {
      receivedState = state
    })

    scheduler.step(1000)

    // Should have timing properties
    expect(receivedState).toHaveProperty('time')
    expect(receivedState).toHaveProperty('delta')
    expect(receivedState).toHaveProperty('elapsed')
    expect(receivedState).toHaveProperty('frame')

    // Should NOT have any injected host state
    expect(receivedState.gl).toBeUndefined()
    expect(receivedState.scene).toBeUndefined()
    expect(receivedState.camera).toBeUndefined()
  })
})

//* Root Ready Tests ==============================

describe('Scheduler Root Ready', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
  })

  it('isReady returns false when no roots registered', () => {
    const scheduler = Scheduler.get()
    expect(scheduler.isReady).toBe(false)
  })

  it('isReady returns true after root is registered', () => {
    const scheduler = Scheduler.get()

    scheduler.registerRoot('test-root', {
      getState: () => ({}),
    })

    expect(scheduler.isReady).toBe(true)
  })

  it('onRootReady fires immediately if already ready', () => {
    const scheduler = Scheduler.get()

    scheduler.registerRoot('test-root', {
      getState: () => ({}),
    })

    let ready = false
    scheduler.onRootReady(() => {
      ready = true
    })

    // Should fire immediately since root is already registered
    expect(ready).toBe(true)
  })

  it('onRootReady fires when root registers', () => {
    const scheduler = Scheduler.get()

    let ready = false
    scheduler.onRootReady(() => {
      ready = true
    })

    expect(ready).toBe(false)

    scheduler.registerRoot('test-root', {
      getState: () => ({}),
    })

    expect(ready).toBe(true)
  })

  it('onRootReady returns unsubscribe function', () => {
    const scheduler = Scheduler.get()

    let calls = 0
    const unsubscribe = scheduler.onRootReady(() => {
      calls++
    })

    // Unsubscribe before any root is registered
    unsubscribe()

    // Register root
    scheduler.registerRoot('test-root', {
      getState: () => ({}),
    })

    // Should NOT have fired
    expect(calls).toBe(0)
  })
})

//* Error Handling Tests ==============================

describe('Scheduler Error Handling', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
  })

  it('uses pluggable error handler from registerRoot', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    const errors: Error[] = []
    const errorHandler = (err: Error) => errors.push(err)

    scheduler.registerRoot('test-root', {
      getState: () => ({}),
      onError: errorHandler,
    })

    // Register a job that throws
    scheduler.register(
      () => {
        throw new Error('Test error')
      },
      { rootId: 'test-root' },
    )

    // Suppress console.error for this test
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    scheduler.step(1000)

    errorSpy.mockRestore()

    // Error should have been captured by our handler
    expect(errors.length).toBe(1)
    expect(errors[0].message).toBe('Test error')
  })

  it('falls back to console.error when no error handler provided', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.registerRoot('test-root', {
      getState: () => ({}),
      // No onError provided
    })

    scheduler.register(
      () => {
        throw new Error('Test error')
      },
      { rootId: 'test-root' },
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    scheduler.step(1000)

    // Should have logged to console.error
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('triggerError calls the bound error handler', () => {
    const scheduler = Scheduler.get()

    const errors: Error[] = []
    scheduler.registerRoot('test-root', {
      onError: (err) => errors.push(err),
    })

    scheduler.triggerError(new Error('Manual error'))

    expect(errors.length).toBe(1)
    expect(errors[0].message).toBe('Manual error')
  })
})

//* Ambient Root & Host Adoption ==============================
// @see docs/design/ambient-root.md

describe('Ambient root & host adoption', () => {
  const AMBIENT_ID = Scheduler.AMBIENT_ID

  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
  })

  //* Lazy ambient root --------------------------------

  it('register() with no host lazily creates the ambient root and runs the job', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    expect(scheduler.getRootCount()).toBe(0)

    const calls: number[] = []
    scheduler.register((state) => calls.push(state.frame))

    expect(scheduler.getRootCount()).toBe(1)
    expect(scheduler.getJobCount()).toBe(1)

    scheduler.step(1000)
    expect(calls.length).toBe(1)
  })

  it('ambient job receives timing-only ({}) state before any host attaches', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    let received: any
    scheduler.register((state) => {
      received = state
    })
    scheduler.step(1000)

    expect(received).toHaveProperty('frame')
    expect(received.camera).toBeUndefined()
    expect(received.gl).toBeUndefined()
  })

  it('does not warn when registering without a host', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.register(() => {})

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still warns and no-ops for an explicit rootId that does not exist', () => {
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.register(() => {}, { rootId: 'nope' })

    expect(warn).toHaveBeenCalled()
    expect(scheduler.getJobCount()).toBe(0)
    warn.mockRestore()
  })

  it('starts the loop on the first ambient job (frameloop=always)', () => {
    const scheduler = Scheduler.get()
    expect(scheduler.isRunning).toBe(false)

    scheduler.register(() => {})

    expect(scheduler.isRunning).toBe(true)
  })

  //* Host adoption --------------------------------

  it('first host adopts ambient orphan jobs, preserving id and phase', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.register(() => {}, { id: 'orphan', phase: 'render' })
    expect(scheduler.getRootCount()).toBe(1)

    scheduler.registerRoot('host', { getState: () => ({ camera: 'cam' }) })

    // Ambient gone, host is the sole root, job preserved
    expect(scheduler.getRootCount()).toBe(1)
    expect(scheduler.getJobIds()).toEqual(['orphan'])
    expect(scheduler.hasUserJobsInPhase('render', 'host')).toBe(true)
  })

  it('removes the ambient root after adoption', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.register(() => {}, { id: 'orphan' })
    scheduler.registerRoot('host', { getState: () => ({}) })

    expect(scheduler.hasUserJobsInPhase('update', AMBIENT_ID)).toBe(false)
    expect(scheduler.getRootCount()).toBe(1)
  })

  it('delivers host state to adopted jobs (and {} before adoption)', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    const seen: any[] = []
    scheduler.register((state: any) => seen.push(state.camera), { id: 'orphan' })

    scheduler.step(1000)
    expect(seen[seen.length - 1]).toBeUndefined() // pre-adoption: no host state

    scheduler.registerRoot('host', { getState: () => ({ camera: 'cam' }) })
    scheduler.step(2000)
    expect(seen[seen.length - 1]).toBe('cam') // post-adoption: host state
  })

  it('preserves fps throttle state across adoption', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    let runs = 0
    scheduler.register(() => runs++, { id: 'throttled', fps: 30, drop: true })

    scheduler.step(1000) // runs (first call), sets lastRun = 1000
    expect(runs).toBe(1)

    scheduler.registerRoot('host', { getState: () => ({}) })

    // Only ~1ms later: still throttled (lastRun migrated with the job)
    scheduler.step(1001)
    expect(runs).toBe(1)

    // Past the 1/30s interval: runs again
    scheduler.step(1100)
    expect(runs).toBe(2)
  })

  it('preserves pause state and job-state listeners across adoption', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.register(() => {}, { id: 'pausable' })
    scheduler.pauseJob('pausable')
    expect(scheduler.isJobPaused('pausable')).toBe(true)

    let notified = 0
    scheduler.subscribeJobState('pausable', () => notified++)

    scheduler.registerRoot('host', { getState: () => ({}) })

    // Pause state survived the migration
    expect(scheduler.isJobPaused('pausable')).toBe(true)
    // Listener (keyed by job id) survived and still fires
    scheduler.resumeJob('pausable')
    expect(notified).toBe(1)
    expect(scheduler.isJobPaused('pausable')).toBe(false)
  })

  it('does NOT adopt jobs registered with an explicit rootId', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.registerRoot('owned', { getState: () => ({}) })
    scheduler.register(() => {}, { id: 'pinned', rootId: 'owned' })

    // A second host registers; ambient never existed, nothing to adopt
    scheduler.registerRoot('host2', { getState: () => ({}) })

    expect(scheduler.hasUserJobsInPhase('update', 'owned')).toBe(true)
    expect(scheduler.hasUserJobsInPhase('update', 'host2')).toBe(false)
  })

  it('only the first host adopts; a second host adopts nothing', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.register(() => {}, { id: 'orphan' })
    scheduler.registerRoot('host1', { getState: () => ({}) })
    scheduler.registerRoot('host2', { getState: () => ({}) })

    expect(scheduler.getRootCount()).toBe(2)
    expect(scheduler.hasUserJobsInPhase('update', 'host1')).toBe(true)
    expect(scheduler.hasUserJobsInPhase('update', 'host2')).toBe(false)
  })

  it('adoption does not trip the loop-stop / error-handler teardown', () => {
    const scheduler = Scheduler.get() // frameloop defaults to 'always'

    scheduler.register(() => {}, { id: 'orphan' })
    expect(scheduler.isRunning).toBe(true)

    const errors: Error[] = []
    scheduler.registerRoot('host', { getState: () => ({}), onError: (e) => errors.push(e) })

    // Loop kept running through adoption...
    expect(scheduler.isRunning).toBe(true)
    // ...and the host's error handler is bound (not cleared by ambient teardown)
    scheduler.triggerError(new Error('boom'))
    expect(errors.map((e) => e.message)).toEqual(['boom'])
  })

  it('preserves custom phases on adopted jobs', () => {
    const scheduler = Scheduler.get()
    scheduler.frameloop = 'never'

    scheduler.addPhase('ai', { after: 'physics', before: 'update' })
    const order: string[] = []
    scheduler.register(() => order.push('ai'), { id: 'ai-job', phase: 'ai' })
    scheduler.register(() => order.push('update'), { id: 'update-job', phase: 'update' })

    scheduler.registerRoot('host', { getState: () => ({}) })
    scheduler.step(1000)

    expect(order).toEqual(['ai', 'update'])
  })
})

//* Phase 1: Lifecycle Hardening ==============================
// Driver ownership, targeted stepping, and root introspection.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('Scheduler lifecycle hardening', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  //* Task 1: bulk setter ----------------------------------------

  it('warns once when the bulk frameloop setter is used with multiple roots', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.registerRoot('one')
    scheduler.frameloop = 'demand'
    expect(warn).not.toHaveBeenCalled()

    scheduler.registerRoot('two')
    scheduler.frameloop = 'always'
    scheduler.frameloop = 'demand'

    // Warn-once: r3f writes this on every render, so a per-call warn would flood.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('setRootFrameloop')

    warn.mockRestore()
  })

  it('sets the default for new roots without touching existing ones', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('existing', { frameloop: 'always' })
    scheduler.defaultFrameloop = 'demand'

    expect(scheduler.defaultFrameloop).toBe('demand')
    expect(scheduler.getRootFrameloop('existing')).toBe('always')

    scheduler.registerRoot('fresh')
    expect(scheduler.getRootFrameloop('fresh')).toBe('demand')
  })

  //* Task 2: stepRoot -------------------------------------------

  it('steps a single root without ticking its siblings', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('live', { frameloop: 'always' })
    scheduler.registerRoot('manual', { frameloop: 'never' })
    scheduler.register(() => calls.push('live'), { rootId: 'live' })
    scheduler.register(() => calls.push('manual'), { rootId: 'manual' })

    raf.flush(1000)
    scheduler.stepRoot('manual', 1016)

    // The r3f advance()/XR case: the always sibling must not tick twice.
    expect(calls).toEqual(['live', 'manual'])
  })

  it('runs global jobs on stepRoot but leaves pending demand frames alone', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => calls.push('job'), { rootId: 'demand' })
    scheduler.registerGlobal('before', 'global', () => calls.push('global'))

    scheduler.invalidateRoot('demand', 2)
    scheduler.stepRoot('demand', 1000)

    expect(calls).toEqual(['global', 'job'])

    raf.flush(1016)
    raf.flush(1032)

    expect(calls.filter((c) => c === 'job')).toHaveLength(3)
  })

  it('warns and no-ops when stepping an unknown root', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.stepRoot('missing')

    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  //* Task 3: sticky stop ----------------------------------------

  it('stays stopped after stop() when roots mount or re-configure', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.register(() => {}, { rootId: 'always' })
    raf.flush(1000)

    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)

    scheduler.registerRoot('other') // a Canvas mounts
    expect(scheduler.isRunning).toBe(false)

    scheduler.frameloop = 'always' // an r3f re-configure
    expect(scheduler.isRunning).toBe(false)

    scheduler.setRootFrameloop('other', 'demand') // a mode change
    expect(scheduler.isRunning).toBe(false)
  })

  it('resumes from stop() on explicit start or invalidation', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => {}, { rootId: 'demand' })

    scheduler.stop()
    scheduler.invalidateRoot('demand')
    expect(scheduler.isRunning).toBe(true)

    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)

    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
  })

  it('still steps manually while paused', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('root', { frameloop: 'always' })
    scheduler.register(() => calls.push('root'), { rootId: 'root' })

    scheduler.stop()
    scheduler.step(1000)
    scheduler.stepRoot('root', 1016)

    expect(calls).toEqual(['root', 'root'])
    expect(scheduler.isRunning).toBe(false)
  })

  it('does not latch paused when the last root unregisters', () => {
    createRafController()
    const scheduler = Scheduler.get()

    const unregister = scheduler.registerRoot('only', { frameloop: 'always' })
    scheduler.register(() => {}, { rootId: 'only' })
    expect(scheduler.isRunning).toBe(true)

    unregister()
    expect(scheduler.isRunning).toBe(false)

    // Teardown must not read as an explicit stop().
    scheduler.registerRoot('next', { frameloop: 'always' })
    expect(scheduler.isRunning).toBe(true)
  })

  //* Task 4: entering demand ------------------------------------

  it('sleeps immediately on entering demand, however the root got there', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    let switched = 0
    let registered = 0

    scheduler.registerRoot('switched', { frameloop: 'always' })
    scheduler.register(() => switched++, { rootId: 'switched' })

    raf.flush(1000)
    expect(switched).toBe(1)

    // Entering demand grants nothing — a demand root draws only when invalidated,
    // and registering as demand must behave identically to switching to it.
    scheduler.setRootFrameloop('switched', 'demand')
    scheduler.registerRoot('registered', { frameloop: 'demand' })
    scheduler.register(() => registered++, { rootId: 'registered' })

    raf.flush(1016)
    raf.flush(1032)

    expect(switched).toBe(1)
    expect(registered).toBe(0)
    expect(scheduler.isRunning).toBe(false)
  })

  //* Task 5: introspection --------------------------------------

  it('exposes root ids and modes', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('a', { frameloop: 'demand' })
    scheduler.registerRoot('b')

    expect(scheduler.getRootIds()).toEqual(['a', 'b'])
    expect(scheduler.getRootFrameloop('a')).toBe('demand')
    expect(scheduler.getRootFrameloop('missing')).toBeUndefined()
  })

  it('resolves a job root id across adoption', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.register(() => {}, { id: 'orphan' })
    expect(scheduler.getJobRootId('orphan')).toBe(Scheduler.AMBIENT_ID)

    scheduler.registerRoot('host')
    expect(scheduler.getJobRootId('orphan')).toBe('host')
    expect(scheduler.getJobRootId('nope')).toBeUndefined()
  })
})

//* Phase 2: Per-root Timing ==============================
// delta and elapsed belong to the root, not the driver — a sleeping root must
// not accumulate time it never saw.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('Scheduler per-root timing', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  it('gives an always root the driver frame delta, unchanged', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('root', { frameloop: 'always' })
    scheduler.register((_state, delta) => deltas.push(delta), { rootId: 'root' })

    raf.flush(1000)
    raf.flush(1016)
    raf.flush(1032)

    expect(deltas[0]).toBe(0) // first tick has no previous frame
    expect(deltas[1]).toBeCloseTo(0.016, 5)
    expect(deltas[2]).toBeCloseTo(0.016, 5)
  })

  it('caps a waking demand root at one driver frame instead of fast-forwarding', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => {}, { rootId: 'always' })
    scheduler.register((_state, delta) => deltas.push(delta), { rootId: 'demand' })

    scheduler.invalidateRoot('demand')
    raf.flush(1000)

    // The sibling keeps the driver alive for ~half a second while demand sleeps.
    for (let frame = 1; frame <= 30; frame++) raf.flush(1000 + frame * 16)

    scheduler.invalidateRoot('demand')
    raf.flush(1000 + 31 * 16)

    expect(deltas).toHaveLength(2)
    // 480ms of wall clock passed, but the root resumes rather than jumping.
    expect(deltas[1]).toBeCloseTo(0.016, 5)
  })

  it('caps the wake delta whether or not a sibling kept the driver alive', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register((_state, delta) => deltas.push(delta), { rootId: 'demand' })

    scheduler.invalidateRoot('demand')
    raf.flush(1000)
    expect(scheduler.isRunning).toBe(false) // driver stopped entirely

    scheduler.invalidateRoot('demand')
    raf.flush(9000) // 8 seconds later

    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toBeLessThan(0.05) // bounded, no teleport
    expect(deltas[1]).toBeGreaterThanOrEqual(0)
  })

  it('accumulates elapsed from the deltas that root actually received', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    let summed = 0
    let reported = 0

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => {}, { rootId: 'always' })
    scheduler.register(
      (state, delta) => {
        summed += delta
        reported = state.elapsed
      },
      { rootId: 'demand' },
    )

    for (let frame = 0; frame < 20; frame++) {
      if (frame % 5 === 0) scheduler.invalidateRoot('demand')
      raf.flush(1000 + frame * 16)
    }

    expect(reported).toBeCloseTo(summed, 10)
    // Driver ran 20 frames; this root saw 4, so elapsed must not be ~0.32s.
    expect(reported).toBeLessThan(0.1)
  })

  it('restores catch-up semantics with maxDelta: Infinity', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand', maxDelta: Infinity })
    scheduler.register(() => {}, { rootId: 'always' })
    scheduler.register((_state, delta) => deltas.push(delta), { rootId: 'demand' })

    scheduler.invalidateRoot('demand')
    raf.flush(1000)

    for (let frame = 1; frame <= 30; frame++) raf.flush(1000 + frame * 16)

    scheduler.invalidateRoot('demand')
    raf.flush(1000 + 31 * 16)

    // Full wall clock from its own last tick at t=1000 — v9 THREE.Clock behavior.
    expect(deltas[1]).toBeCloseTo(0.496, 5)
  })

  it('starts a late-registered root at elapsed 0', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const elapsed: number[] = []

    scheduler.registerRoot('early', { frameloop: 'always' })
    scheduler.register(() => {}, { rootId: 'early' })
    for (let frame = 0; frame < 10; frame++) raf.flush(1000 + frame * 16)

    scheduler.registerRoot('late', { frameloop: 'always' })
    scheduler.register((state) => elapsed.push(state.elapsed), { rootId: 'late' })

    raf.flush(1000 + 10 * 16)
    raf.flush(1000 + 11 * 16)

    // Not "how long the app has been running".
    expect(elapsed[0]).toBe(0)
    expect(elapsed[1]).toBeCloseTo(0.016, 5)
  })

  it('carries accumulated time across ambient adoption', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const elapsed: number[] = []

    scheduler.register((state) => elapsed.push(state.elapsed), { id: 'orphan' })
    raf.flush(1000)
    raf.flush(1016)
    raf.flush(1032)

    const beforeAdoption = elapsed.at(-1)!
    expect(beforeAdoption).toBeCloseTo(0.032, 5)

    scheduler.registerRoot('host', { frameloop: 'always' })
    raf.flush(1048)

    // Adoption changes the owning root, not the job's sense of time.
    expect(elapsed.at(-1)!).toBeCloseTo(beforeAdoption + 0.016, 5)
  })

  it('keeps job deltas continuous across ambient adoption', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.register((_state, delta) => deltas.push(delta), { id: 'orphan' })
    raf.flush(1000)
    raf.flush(1016)

    scheduler.registerRoot('host', { frameloop: 'always' })
    raf.flush(1032)

    // A job's delta is measured against its root's accumulated clock, so adoption
    // must carry that clock over — otherwise the first post-adoption delta is
    // differenced against a reset root and comes out wrong.
    expect(deltas.at(-1)).toBeCloseTo(0.016, 5)
  })
})

//* Phase 3: Throttled Job Deltas ==============================
// A job that doesn't run every frame must be told how much time it actually
// missed, or delta-driven work silently runs slow.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('Scheduler throttled job timing', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  it('gives a throttled job the time since its own last run', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const throttled: number[] = []
    const everyFrame: number[] = []

    scheduler.registerRoot('root', { frameloop: 'always' })
    scheduler.register((_state, delta) => throttled.push(delta), { rootId: 'root', fps: 30 })
    scheduler.register((_state, delta) => everyFrame.push(delta), { rootId: 'root' })

    for (let frame = 0; frame < 7; frame++) raf.flush(1000 + frame * 16)

    // At 16ms frames an fps:30 job lands every third frame — 48ms, not 16ms.
    // Being told 16ms is what made `x += delta * speed` run at a third speed.
    expect(throttled.length).toBeGreaterThan(1)
    expect(throttled[1]).toBeCloseTo(0.048, 5)
    expect(everyFrame[1]).toBeCloseTo(0.016, 5)
  })

  it('does not let a throttled job teleport when its root slept', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('always', { frameloop: 'always' })
    scheduler.registerRoot('demand', { frameloop: 'demand' })
    scheduler.register(() => {}, { rootId: 'always' })
    scheduler.register((_state, delta) => deltas.push(delta), { rootId: 'demand', fps: 30 })

    scheduler.invalidateRoot('demand')
    raf.flush(1000)

    // Sibling keeps the driver alive for half a second while demand sleeps.
    for (let frame = 1; frame <= 30; frame++) raf.flush(1000 + frame * 16)

    scheduler.invalidateRoot('demand')
    raf.flush(1000 + 31 * 16)

    // The root only experienced one capped frame in between, so the job does too.
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toBeCloseTo(0.016, 5)
  })

  it('does not charge a resumed job for the time it was paused', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const deltas: number[] = []

    scheduler.registerRoot('root', { frameloop: 'always' })
    scheduler.register((_state, delta) => deltas.push(delta), { id: 'job', rootId: 'root' })

    raf.flush(1000)
    raf.flush(1016)

    scheduler.pauseJob('job')
    for (let frame = 2; frame < 40; frame++) raf.flush(1000 + frame * 16)
    scheduler.resumeJob('job')

    raf.flush(1000 + 40 * 16)

    expect(deltas.at(-1)).toBeCloseTo(0.016, 5)
  })
})

//* Phase 3: Constraint Target Resolution ==============================
// An unresolvable before/after target used to invent a phase and append it after
// `finish`, permanently, for every root.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('Scheduler constraint target resolution', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  it("places a job referencing another job id into that job's phase", () => {
    createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('root')
    scheduler.register(() => calls.push('target'), { id: 'target', rootId: 'root', phase: 'render' })
    scheduler.register(() => calls.push('follower'), { rootId: 'root', after: 'target' })
    scheduler.register(() => calls.push('finish'), { rootId: 'root', phase: 'finish' })

    scheduler.step(1000)

    // Runs in render, right after its target — not stranded after finish.
    expect(calls).toEqual(['target', 'follower', 'finish'])
    expect(scheduler.hasPhase('after:target')).toBe(false)
    expect(scheduler.phases).toEqual(['start', 'input', 'physics', 'update', 'render', 'finish'])
  })

  it('warns and defaults to update for an unresolvable target', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []

    scheduler.registerRoot('root')
    scheduler.register(() => calls.push('orphan'), { rootId: 'root', after: 'nothing-here' })
    scheduler.register(() => calls.push('render'), { rootId: 'root', phase: 'render' })

    scheduler.step(1000)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['orphan', 'render']) // update runs before render
    expect(scheduler.phases).not.toContain('after:nothing-here')

    warn.mockRestore()
  })

  it('still auto-generates a phase for a real phase target', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('root')
    scheduler.register(() => {}, { rootId: 'root', before: 'render' })

    expect(scheduler.hasPhase('before:render')).toBe(true)
    expect(scheduler.phases.indexOf('before:render')).toBeLessThan(scheduler.phases.indexOf('render'))
  })
})

//* Phase 4: Cross-root Ordering ==============================
// Roots ran in Map registration order, which Suspense, conditional rendering, or
// a remount can reverse. Shared-renderer canvases need a stable answer.
// @see docs/superpowers/plans/2026-08-11-lifecycle-followups.md

describe('Scheduler root ordering', () => {
  beforeEach(() => {
    Scheduler.reset()
  })

  afterEach(() => {
    Scheduler.reset()
    vi.unstubAllGlobals()
  })

  it('runs roots by order regardless of registration sequence', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    // Registered backwards, as a Suspense boundary resolving out of order would.
    scheduler.registerRoot('overlay', { order: 10 })
    scheduler.registerRoot('main', { order: 0 })
    scheduler.register(() => calls.push('overlay'), { rootId: 'overlay' })
    scheduler.register(() => calls.push('main'), { rootId: 'main' })

    raf.flush(1000)

    expect(calls).toEqual(['main', 'overlay'])
    expect(scheduler.getRootIds()).toEqual(['main', 'overlay'])
  })

  it('runs a root after its dependency regardless of registration sequence', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    // The dependent root mounts first, as can happen through Suspense.
    scheduler.registerRoot('overlay', { after: 'main' })
    scheduler.registerRoot('main')
    scheduler.register(() => calls.push('overlay'), { rootId: 'overlay' })
    scheduler.register(() => calls.push('main'), { rootId: 'main' })

    raf.flush(1000)

    expect(calls).toEqual(['main', 'overlay'])
    expect(scheduler.getRootIds()).toEqual(['main', 'overlay'])
  })

  it('falls back to registration order for equal orders', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('first')
    scheduler.registerRoot('second')
    scheduler.registerRoot('third')
    scheduler.register(() => calls.push('first'), { rootId: 'first' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })
    scheduler.register(() => calls.push('third'), { rootId: 'third' })

    raf.flush(1000)

    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('supports dependency chains that override numeric order', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('finish', { order: -100, after: 'middle' })
    scheduler.registerRoot('middle', { after: 'start' })
    scheduler.registerRoot('start', { order: 100 })

    expect(scheduler.getRootIds()).toEqual(['start', 'middle', 'finish'])
  })

  it('deduplicates equivalent before and after constraints', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.registerRoot('second', { after: 'first' })
    scheduler.registerRoot('first', { before: 'second' })

    expect(scheduler.getRootIds()).toEqual(['first', 'second'])
    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
  })

  it('resolves dormant constraints when a referenced root registers later', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const unregisterOverlay = scheduler.registerRoot('overlay', { after: 'main' })
    expect(scheduler.getRootIds()).toEqual(['overlay'])

    const unregisterMain = scheduler.registerRoot('main')
    expect(scheduler.getRootIds()).toEqual(['main', 'overlay'])

    unregisterMain()
    expect(scheduler.getRootIds()).toEqual(['overlay'])

    scheduler.registerRoot('main')
    expect(scheduler.getRootIds()).toEqual(['main', 'overlay'])
    expect(warn).not.toHaveBeenCalled()

    unregisterOverlay()
    warn.mockRestore()
  })

  it('replaces and clears constraints at runtime', () => {
    createRafController()
    const scheduler = Scheduler.get()

    scheduler.registerRoot('middle')
    scheduler.registerRoot('first')
    scheduler.registerRoot('last')
    expect(scheduler.getRootIds()).toEqual(['middle', 'first', 'last'])

    scheduler.setRootConstraints('middle', { after: 'first', before: 'last' })
    expect(scheduler.getRootIds()).toEqual(['first', 'middle', 'last'])

    scheduler.setRootConstraints('middle', { after: 'last', before: 'first' })
    expect(scheduler.getRootIds()).toEqual(['last', 'middle', 'first'])

    scheduler.setRootConstraints('middle', {})
    expect(scheduler.getRootIds()).toEqual(['middle', 'first', 'last'])
  })

  it('does not rebuild equivalent normalized constraints', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.registerRoot('first', {
      before: ['second', 'third'],
      after: ['second', 'third'],
    })
    scheduler.registerRoot('second')
    scheduler.registerRoot('third')

    scheduler.getRootIds()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockClear()

    scheduler.setRootConstraints('first', {
      before: ['third', 'second', 'second'],
      after: ['third', 'second', 'third'],
    })
    scheduler.getRootIds()
    scheduler.setRootConstraints('first', {
      before: ['second', 'third'],
      after: ['second', 'third'],
    })
    scheduler.getRootIds()

    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
  })

  it('applies constraint changes made during a frame on the next frame', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []
    let changed = false

    scheduler.registerRoot('first')
    scheduler.registerRoot('second')
    scheduler.register(
      () => {
        calls.push('first')
        if (!changed) {
          changed = true
          scheduler.setRootConstraints('first', { after: 'second' })
        }
      },
      { rootId: 'first' },
    )
    scheduler.register(() => calls.push('second'), { rootId: 'second' })

    raf.flush(1000)
    expect(calls).toEqual(['first', 'second'])

    raf.flush(1016)
    expect(calls).toEqual(['first', 'second', 'second', 'first'])
  })

  it('orders only roots selected for the current frame', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('overlay', { after: 'main' })
    scheduler.registerRoot('main', { frameloop: 'demand' })
    scheduler.register(() => calls.push('overlay'), { rootId: 'overlay' })
    scheduler.register(() => calls.push('main'), { rootId: 'main' })

    raf.flush(1000)
    expect(calls).toEqual(['overlay'])

    scheduler.invalidateRoot('main')
    raf.flush(1016)
    expect(calls).toEqual(['overlay', 'main', 'overlay'])
  })

  it('warns on dependency cycles and runs every root deterministically', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.registerRoot('first', { after: 'second' })
    scheduler.registerRoot('second', { after: 'first' })
    scheduler.register(() => calls.push('first'), { rootId: 'first' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })

    raf.flush(1000)

    expect(calls).toEqual(['first', 'second'])
    expect(warn).toHaveBeenCalledWith('[Scheduler] Circular dependency detected in root constraints')

    warn.mockRestore()
  })

  it('preserves valid edges entering and leaving a dependency cycle', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Numeric preference puts downstream first, but its edge from second remains
    // valid even though first and second must fall back within their cycle.
    scheduler.registerRoot('downstream', { order: -10, after: 'second' })
    scheduler.registerRoot('first', { after: 'second' })
    scheduler.registerRoot('second', { after: 'first' })
    scheduler.registerRoot('upstream', { order: 10, before: 'first' })

    expect(scheduler.getRootIds()).toEqual(['upstream', 'first', 'second', 'downstream'])
    expect(warn).toHaveBeenCalledWith('[Scheduler] Circular dependency detected in root constraints')

    warn.mockRestore()
  })

  it('reorders at runtime without disturbing sleeping roots', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('a')
    scheduler.registerRoot('b')
    scheduler.registerRoot('asleep', { frameloop: 'demand' })
    scheduler.register(() => calls.push('a'), { rootId: 'a' })
    scheduler.register(() => calls.push('b'), { rootId: 'b' })
    scheduler.register(() => calls.push('asleep'), { rootId: 'asleep' })

    raf.flush(1000)
    expect(calls).toEqual(['a', 'b'])

    scheduler.setRootOrder('b', -1)
    raf.flush(1016)

    // A demand root ordered between them is skipped, not woken to hold its slot.
    expect(calls).toEqual(['a', 'b', 'b', 'a'])
  })

  it('keeps ordering after a root unregisters', () => {
    const raf = createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('late', { order: 5 })
    scheduler.registerRoot('early', { order: 1 })
    const dropMiddle = scheduler.registerRoot('middle', { order: 3 })
    scheduler.register(() => calls.push('late'), { rootId: 'late' })
    scheduler.register(() => calls.push('early'), { rootId: 'early' })
    scheduler.register(() => calls.push('middle'), { rootId: 'middle' })

    raf.flush(1000)
    expect(calls).toEqual(['early', 'middle', 'late'])

    dropMiddle()
    raf.flush(1016)

    expect(calls).toEqual(['early', 'middle', 'late', 'early', 'late'])
  })

  it('orders manual stepping the same way', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const calls: string[] = []

    scheduler.registerRoot('second', { order: 2, frameloop: 'never' })
    scheduler.registerRoot('first', { order: 1, frameloop: 'never' })
    scheduler.register(() => calls.push('second'), { rootId: 'second' })
    scheduler.register(() => calls.push('first'), { rootId: 'first' })

    scheduler.step(1000)

    expect(calls).toEqual(['first', 'second'])
  })

  it('warns and no-ops when ordering an unknown root', () => {
    createRafController()
    const scheduler = Scheduler.get()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    scheduler.setRootOrder('missing', 3)
    scheduler.setRootConstraints('missing', { after: 'also-missing' })

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
