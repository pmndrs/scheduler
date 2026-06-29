import { Scheduler } from '../src/core/scheduler'
import { PhaseGraph } from '../src/core/phaseGraph'
import { rebuildSortedJobs } from '../src/core/sorter'
import { shouldRun } from '../src/core/rateLimiter'
import type { Job } from '../src/types'

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
