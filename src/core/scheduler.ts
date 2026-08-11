//* Scheduler - Global Singleton Job Scheduling System ==============================
// Author: DennisSmolek
/* Note: This is a base draft and solid but not bleeding edge performance based.
It is based on various engine loops end schedule systems like Jokt and https://github.com/pmndrs/directed
It is class based (Krispy will hate it) but the api is solid
*/

import type {
  AddPhaseOptions,
  FrameNextState,
  FrameCallback,
  Frameloop,
  RootOptions,
  Job,
  JobOptions,
  RootEntry,
  GlobalJob,
  FrameLoopState,
  HMRData,
} from '../types'
import { PhaseGraph } from './phaseGraph'
import { rebuildSortedJobs } from './sorter'
import { shouldRun, resetJobTiming } from './rateLimiter'

//* HMR Support ==============================
// Preserve scheduler instance across hot module reloads
// This prevents the render loop from stopping during development
declare const import_meta_hot: HMRData | undefined

// Get HMR data for development hot reloading
// - In production builds: unbuild transforms import.meta.hot to import_meta_hot
// - In tests: Skip entirely (NODE_ENV === 'test')
// - Uses indirect eval to avoid TypeScript parsing import.meta syntax
const hmrData = (() => {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') return undefined
  if (typeof import_meta_hot !== 'undefined') return import_meta_hot
  // Indirect eval prevents TypeScript from parsing import.meta

  try {
    return (0, eval)('import.meta.hot') as HMRData | undefined
  } catch {
    return undefined
  }
})()

/**
 * Global Singleton Scheduler - manages the frame loop and job execution for ALL roots.
 *
 * Features:
 * - Single RAF loop for entire application
 * - Root registration (multiple roots / Canvas support)
 * - Global phases for addEffect/addAfterEffect (deprecated)
 * - Per-root job management with phases, priorities, FPS throttling
 * - onIdle callbacks for addTail (deprecated)
 * - Demand mode support via invalidate()
 */
export class Scheduler {
  //* Static State & Methods (Singleton Usage) ================================

  //* Cross-Bundle Singleton Key ==============================
  // Use Symbol.for() to ensure scheduler is shared across bundle boundaries
  // This guarantees consumers (e.g. @react-three/fiber and any other renderer)
  // share ONE global scheduler instance regardless of how they import it.
  private static readonly INSTANCE_KEY = Symbol.for('@pmndrs/scheduler')

  //* Ambient (hostless) Root ==============================
  // Reserved id for the lazily-created root that standalone jobs attach to when
  // no host has registered yet. A host adopts these jobs when it registers.
  // @see docs/design/ambient-root.md
  static readonly AMBIENT_ID = '__default__'

  private static get instance(): Scheduler | null {
    return (globalThis as any)[Scheduler.INSTANCE_KEY] ?? null
  }

  private static set instance(value: Scheduler | null) {
    ;(globalThis as any)[Scheduler.INSTANCE_KEY] = value
  }

  /**
   * Get the global scheduler instance (creates if doesn't exist).
   * Uses HMR data to preserve instance across hot reloads.
   * @returns {Scheduler} The singleton scheduler instance
   */
  static get(): Scheduler {
    // Try to restore from HMR data first (prevents render loop stopping on HMR)
    if (!Scheduler.instance && hmrData?.data?.scheduler) {
      Scheduler.instance = hmrData.data.scheduler
    }
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler()
      // Store in HMR data for persistence across reloads
      if (hmrData?.data) {
        hmrData.data.scheduler = Scheduler.instance
      }
    }
    return Scheduler.instance
  }

  /**
   * Reset the singleton instance. Stops the loop and clears all state.
   * Primarily used for testing to ensure clean state between tests.
   * @returns {void}
   */
  static reset(): void {
    if (Scheduler.instance) {
      Scheduler.instance.stop()
      Scheduler.instance = null
    }
    // Also clear from HMR data
    if (hmrData?.data) {
      hmrData.data.scheduler = null
    }
  }

  //* Critical State ================================

  private roots: Map<string, RootEntry> = new Map()
  private phaseGraph: PhaseGraph
  private loopState: FrameLoopState = {
    running: false,
    rafHandle: null,
    lastTime: null, // null = uninitialized, 0+ = valid timestamp
    frameCount: 0,
    elapsedTime: 0,
  }

  //* Private State ================================

  private nextRootIndex: number = 0
  private nextRootSequence: number = 0
  private sortedRoots: RootEntry[] = []
  private rootsNeedSort: boolean = true
  private globalBeforeJobs: Map<string, GlobalJob> = new Map()
  private globalAfterJobs: Map<string, GlobalJob> = new Map()
  private nextGlobalIndex: number = 0
  private idleCallbacks: Set<(timestamp: number) => void> = new Set()
  private nextJobIndex: number = 0
  private jobStateListeners: Map<string, Set<() => void>> = new Map()
  private _frameloop: Frameloop = 'always'
  private forceRunning: boolean = false
  private paused: boolean = false
  private warnedBulkFrameloop: boolean = false

  //* Error Handling & Root-Ready State ================================

  private errorHandler: ((error: Error) => void) | null = null
  private rootReadyCallbacks: Set<() => void> = new Set()

  //* Getters & Setters ================================

  get phases(): string[] {
    return this.phaseGraph.getOrderedPhases()
  }

  /**
   * Legacy bulk control. Reading returns the default applied to roots registered
   * later; writing sets that default AND applies the mode to every existing root.
   *
   * With more than one root this is last-writer-wins across hosts — prefer
   * {@link Scheduler.setRootFrameloop} for per-root control and
   * {@link Scheduler.defaultFrameloop} to change only the default.
   */
  get frameloop(): Frameloop {
    return this._frameloop
  }

  set frameloop(mode: Frameloop) {
    // Warn once, not per call: hosts commonly write this on every render, so a
    // per-call warning would flood the console.
    if (this.roots.size > 1 && !this.warnedBulkFrameloop) {
      this.warnedBulkFrameloop = true
      console.warn(
        `[Scheduler] scheduler.frameloop applied to ${this.roots.size} roots. ` +
          `Use setRootFrameloop(rootId, mode) for per-root control.`,
      )
    }

    this._frameloop = mode

    for (const root of this.roots.values()) {
      this.applyRootFrameloop(root, mode)
    }

    this.reconcileLoop()
  }

  /**
   * The mode given to roots that register without an explicit `frameloop`.
   * Unlike {@link Scheduler.frameloop}, setting this leaves existing roots alone.
   */
  get defaultFrameloop(): Frameloop {
    return this._frameloop
  }

  set defaultFrameloop(mode: Frameloop) {
    this._frameloop = mode
  }

  get isRunning(): boolean {
    return this.loopState.running
  }

  get isReady(): boolean {
    return this.roots.size > 0
  }

  //* Constructor ================================

  constructor() {
    this.phaseGraph = new PhaseGraph()
  }

  //* Root Management Methods ================================

  /**
   * Register a root with the scheduler.
   * The first root to register starts the RAF loop (if frameloop='always').
   * @param {string} id - Unique identifier for this root
   * @param {RootOptions} [options] - Optional configuration with getState and onError callbacks
   * @returns {() => void} Unsubscribe function to remove this root
   */
  registerRoot(id: string, options: RootOptions = {}): () => void {
    if (this.roots.has(id)) {
      console.warn(`[Scheduler] Root "${id}" already registered`)
      return () => this.unregisterRoot(id)
    }

    const entry: RootEntry = {
      id,
      getState: options.getState ?? (() => ({})),
      jobs: new Map(),
      sortedJobs: [],
      needsRebuild: false,
      frameloop: options.frameloop ?? this._frameloop,
      pendingFrames: 0,
      order: options.order ?? 0,
      sequence: this.nextRootSequence++,
      lastTickTime: null,
      accumulatedTime: 0,
      maxDelta: options.maxDelta,
    }

    // Bind error handler from root
    // Always update if provided - allows new roots to override stale handlers
    // @see https://github.com/pmndrs/react-three-fiber/issues/3651
    if (options.onError) {
      this.errorHandler = options.onError
    }

    this.roots.set(id, entry)
    this.rootsNeedSort = true

    // Notify waiters on first root
    if (this.roots.size === 1) {
      this.notifyRootReady()
    }

    // Host adoption: the first non-ambient root to register adopts any orphan
    // jobs accumulated on the ambient root (e.g. a useFrame child whose layout
    // effect ran before its host's). Runs after the size check above so that
    // check reflects the pre-adoption count.
    // @see docs/design/ambient-root.md
    if (id !== Scheduler.AMBIENT_ID) {
      this.adoptAmbientOrphans(entry)
    }

    this.reconcileLoop()

    return () => this.unregisterRoot(id)
  }

  /**
   * Migrate orphan jobs from the ambient root into a newly registered host root,
   * then drop the now-empty ambient root. Preserves job identity and all per-job
   * state (id, phase/order, fps throttle via `job.lastRun`, pause state, and
   * `jobStateListeners`, which are keyed by job id) — only the owning root changes.
   *
   * Sequenced so `roots.size` never hits 0 (the host root is already added),
   * avoiding the loop-stop / error-handler-clear teardown in `unregisterRoot`.
   * @param {RootEntry} hostRoot - The root adopting the orphan jobs.
   * @returns {void}
   * @private
   * @see docs/design/ambient-root.md
   */
  private adoptAmbientOrphans(hostRoot: RootEntry): void {
    const ambient = this.roots.get(Scheduler.AMBIENT_ID)
    if (!ambient || ambient === hostRoot) return

    // Move each orphan job to the host root, preserving id and per-job state.
    for (const [jobId, job] of ambient.jobs) {
      if (hostRoot.jobs.has(jobId)) {
        console.warn(`[Scheduler] Job id "${jobId}" already on host root; keeping host job.`)
        continue
      }
      hostRoot.jobs.set(jobId, job)
    }
    if (ambient.jobs.size > 0) {
      hostRoot.needsRebuild = true
      // Carry the ambient clock across. Adoption changes which root owns a job,
      // not the job's sense of time — resetting would snap any elapsed-driven
      // animation that had been running standalone.
      hostRoot.lastTickTime = ambient.lastTickTime
      hostRoot.accumulatedTime = ambient.accumulatedTime
    }

    // Clear ambient's jobs BEFORE unregister so its teardown doesn't delete the
    // jobStateListeners we just migrated, then drop the now-empty ambient root.
    ambient.jobs.clear()
    this.unregisterRoot(Scheduler.AMBIENT_ID)
  }

  /**
   * Unregister a root from the scheduler.
   * Cleans up all job state listeners for this root's jobs.
   * The last root to unregister stops the RAF loop.
   * @param {string} id - The root ID to unregister
   * @returns {void}
   */
  unregisterRoot(id: string): void {
    const root = this.roots.get(id)
    if (!root) return

    // Clean up job state listeners for this root's jobs
    for (const jobId of root.jobs.keys()) {
      this.jobStateListeners.delete(jobId)
    }

    this.roots.delete(id)
    this.rootsNeedSort = true

    // Last root stops the loop and clears error handler.
    // Uses stopLoop() rather than stop(): teardown must not latch the paused
    // flag, or a later root registration would silently stay frozen.
    if (this.roots.size === 0) {
      this.forceRunning = false
      this.stopLoop()
      // Clear error handler to avoid stale references when new roots register
      // @see https://github.com/pmndrs/react-three-fiber/issues/3651
      this.errorHandler = null
      return
    }

    this.reconcileLoop()
  }

  /**
   * Subscribe to be notified when a root becomes available. Fires immediately if
   * a root already exists.
   *
   * Note: under the ambient-root model this signals "a root exists" — which now
   * includes the lazily-created ambient root, so it fires on the first
   * `register()` even when no host has attached. It is not a "host state ready"
   * signal. @see docs/design/ambient-root.md
   * @param {() => void} callback - Function called when the first root registers
   * @returns {() => void} Unsubscribe function
   */
  onRootReady(callback: () => void): () => void {
    if (this.roots.size > 0) {
      callback()
      return () => {}
    }
    this.rootReadyCallbacks.add(callback)
    return () => this.rootReadyCallbacks.delete(callback)
  }

  /**
   * Notify all registered root-ready callbacks.
   * Called when the first root registers.
   * @returns {void}
   * @private
   */
  private notifyRootReady(): void {
    for (const cb of this.rootReadyCallbacks) {
      try {
        cb()
      } catch (error) {
        console.error('[Scheduler] Error in root-ready callback:', error)
      }
    }
    this.rootReadyCallbacks.clear()
  }

  /**
   * Ensure the ambient (hostless) root exists so standalone usage works with no
   * setup. Creates a minimal root with an empty state provider; a host adopts
   * its jobs when it registers.
   * @returns {void}
   * @private
   * @see docs/design/ambient-root.md
   */
  private ensureAmbientRoot(): void {
    if (!this.roots.has(Scheduler.AMBIENT_ID)) {
      this.registerRoot(Scheduler.AMBIENT_ID)
    }
  }

  /**
   * Trigger error handling for job errors.
   * Uses the bound error handler if available, otherwise logs to console.
   * @param {Error} error - The error to handle
   * @returns {void}
   */
  triggerError(error: Error): void {
    if (this.errorHandler) this.errorHandler(error)
    else console.error('[Scheduler]', error)
  }

  //* Phase Management Methods ================================

  /**
   * Add a named phase to the scheduler's execution order.
   * Marks all roots for rebuild to incorporate the new phase.
   * @param {string} name - The phase name (e.g., 'physics', 'postprocess')
   * @param {AddPhaseOptions} [options] - Positioning options (before/after other phases)
   * @returns {void}
   * @example
   * scheduler.addPhase('physics', { before: 'update' });
   * scheduler.addPhase('postprocess', { after: 'render' });
   */
  addPhase(name: string, options?: AddPhaseOptions): void {
    this.phaseGraph.addPhase(name, options)
    // Mark all roots for rebuild
    for (const root of this.roots.values()) {
      root.needsRebuild = true
    }
  }

  /**
   * Check if a phase exists in the scheduler.
   * @param {string} name - The phase name to check
   * @returns {boolean} True if the phase exists
   */
  hasPhase(name: string): boolean {
    return this.phaseGraph.hasPhase(name)
  }

  //* Global Job Registration Methods (Deprecated APIs) ================================

  /**
   * Register a global job that runs once per frame (not per-root).
   * Used internally by deprecated addEffect/addAfterEffect APIs.
   * @param {'before' | 'after'} phase - When to run: 'before' all roots or 'after' all roots
   * @param {string} id - Unique identifier for this global job
   * @param {(timestamp: number) => void} callback - Function called each frame with RAF timestamp
   * @returns {() => void} Unsubscribe function to remove this global job
   * @deprecated Use useFrame with phases instead
   */
  registerGlobal(phase: 'before' | 'after', id: string, callback: (timestamp: number) => void): () => void {
    const job: GlobalJob = { id, callback }

    if (phase === 'before') {
      this.globalBeforeJobs.set(id, job)
    } else {
      this.globalAfterJobs.set(id, job)
    }

    return () => {
      if (phase === 'before') this.globalBeforeJobs.delete(id)
      else this.globalAfterJobs.delete(id)
    }
  }

  //* Idle Callback Methods (Deprecated API) ================================

  /**
   * Register an idle callback that fires when the loop stops.
   * Used internally by deprecated addTail API.
   * @param {(timestamp: number) => void} callback - Function called when loop becomes idle
   * @returns {() => void} Unsubscribe function to remove this idle callback
   * @deprecated Use demand mode with invalidate() instead
   */
  onIdle(callback: (timestamp: number) => void): () => void {
    this.idleCallbacks.add(callback)
    return () => this.idleCallbacks.delete(callback)
  }

  /**
   * Notify all registered idle callbacks.
   * Called when the loop stops in demand mode.
   * @param {number} timestamp - The RAF timestamp when idle occurred
   * @returns {void}
   * @private
   */
  private notifyIdle(timestamp: number): void {
    for (const cb of this.idleCallbacks) {
      try {
        cb(timestamp)
      } catch (error) {
        console.error('[Scheduler] Error in idle callback:', error)
      }
    }
  }

  //* Job Registration & Management Methods ================================

  /**
   * Register a job (frame callback) with a specific root.
   * This is the core registration method used by useFrame internally.
   * @param {FrameNextCallback} callback - The function to call each frame
   * @param {JobOptions & { rootId?: string; system?: boolean }} [options] - Job configuration
   * @param {string} [options.rootId] - Target root ID (defaults to first registered root)
   * @param {string} [options.id] - Unique job ID (auto-generated if not provided)
   * @param {string} [options.phase] - Execution phase (defaults to 'update')
   * @param {number} [options.priority] - Priority within phase (higher = earlier, default 0)
   * @param {number} [options.fps] - FPS throttle limit
   * @param {boolean} [options.drop] - Drop frames when behind (default true)
   * @param {boolean} [options.enabled] - Whether job is active (default true)
   * @param {boolean} [options.system] - Internal flag for system jobs (not user-facing)
   * @returns {() => void} Unsubscribe function to remove this job
   */
  register<T = FrameNextState>(
    callback: FrameCallback<T>,
    options: JobOptions & { rootId?: string; system?: boolean } = {},
  ): () => void {
    // Find the root - use provided rootId or the first registered root.
    const rootId = options.rootId
    let root = rootId ? this.roots.get(rootId) : this.roots.values().next().value

    if (!root) {
      // An explicit rootId that doesn't exist is a caller error — don't silently
      // create an ambient root under the wrong id.
      if (rootId) {
        console.warn(`[Scheduler] Root "${rootId}" not found; job not registered.`)
        return () => {}
      }
      // No host yet: lazily create the ambient root so standalone usage needs no
      // setup. A host that registers later adopts these jobs.
      // @see docs/design/ambient-root.md
      this.ensureAmbientRoot()
      root = this.roots.get(Scheduler.AMBIENT_ID)
    }

    // Guaranteed past this point; satisfies the type narrower.
    if (!root) return () => {}

    const id = options.id ?? this.generateJobId()

    // Resolve phase from options
    let phase = options.phase ?? 'update'

    // If before/after specified without explicit phase, derive one
    if (!options.phase && (options.before || options.after)) {
      phase = this.resolveConstraintPhase(options.before, options.after)
    }

    // Normalize before/after to Sets
    const before = this.normalizeConstraints(options.before)
    const after = this.normalizeConstraints(options.after)

    const job: Job = {
      id,
      callback,
      phase,
      before,
      after,
      priority: options.priority ?? 0,
      index: this.nextJobIndex++,
      fps: options.fps,
      drop: options.drop ?? true,
      enabled: options.enabled ?? true,
      system: options.system ?? false,
    }

    // Handle duplicate IDs (last wins)
    if (root.jobs.has(id)) {
      console.warn(`[useFrame] Job with id "${id}" already exists, replacing`)
    }

    root.jobs.set(id, job)
    root.needsRebuild = true

    return () => this.unregister(id, root.id)
  }

  /**
   * Unregister a job by its ID.
   * Searches all roots if rootId is not provided.
   * @param {string} id - The job ID to unregister
   * @param {string} [rootId] - Optional root ID to search (searches all if not provided)
   * @returns {void}
   */
  unregister(id: string, rootId?: string): void {
    // Find the root containing this job
    const root = rootId ? this.roots.get(rootId) : this.findRootForJob(id)

    if (root?.jobs.delete(id)) {
      root.needsRebuild = true
      this.jobStateListeners.delete(id)
    }
  }

  /**
   * Update a job's options dynamically.
   * Searches all roots to find the job by ID.
   * Phase/constraint changes trigger a rebuild of the sorted job list.
   * @param {string} id - The job ID to update
   * @param {Partial<JobOptions>} options - The options to update
   * @returns {void}
   */
  updateJob(id: string, options: Partial<JobOptions>): void {
    // Find the job across all roots
    const root = this.findRootForJob(id)
    const job = root?.jobs.get(id)

    if (!job || !root) return

    // Update mutable fields
    if (options.priority !== undefined) job.priority = options.priority
    if (options.fps !== undefined) job.fps = options.fps
    if (options.drop !== undefined) job.drop = options.drop

    if (options.enabled !== undefined) {
      const wasEnabled = job.enabled
      job.enabled = options.enabled
      if (!wasEnabled && job.enabled) resetJobTiming(job)
      if (wasEnabled !== job.enabled) root.needsRebuild = true
    }

    // Phase changes require rebuild
    if (options.phase !== undefined || options.before !== undefined || options.after !== undefined) {
      if (options.phase) job.phase = options.phase
      if (options.before !== undefined) job.before = this.normalizeConstraints(options.before)
      if (options.after !== undefined) job.after = this.normalizeConstraints(options.after)
      root.needsRebuild = true
    }
  }

  //* Job State Management Methods ================================

  /**
   * Check if a job is currently paused (disabled).
   * @param {string} id - The job ID to check
   * @returns {boolean} True if the job exists and is paused
   */
  isJobPaused(id: string): boolean {
    const job = this.findRootForJob(id)?.jobs.get(id)
    return job ? !job.enabled : false
  }

  /**
   * Subscribe to state changes for a specific job.
   * Listener is called when job is paused or resumed.
   * @param {string} id - The job ID to subscribe to
   * @param {() => void} listener - Callback invoked on state changes
   * @returns {() => void} Unsubscribe function
   */
  subscribeJobState(id: string, listener: () => void): () => void {
    if (!this.jobStateListeners.has(id)) {
      this.jobStateListeners.set(id, new Set())
    }
    this.jobStateListeners.get(id)!.add(listener)

    return () => {
      this.jobStateListeners.get(id)?.delete(listener)
      if (this.jobStateListeners.get(id)?.size === 0) {
        this.jobStateListeners.delete(id)
      }
    }
  }

  /**
   * Notify all listeners that a job's state has changed.
   * @param {string} id - The job ID that changed
   * @returns {void}
   * @private
   */
  private notifyJobStateChange(id: string): void {
    this.jobStateListeners.get(id)?.forEach((listener) => listener())
  }

  /**
   * Pause a job by ID (sets enabled=false).
   * Notifies any subscribed state listeners.
   * @param {string} id - The job ID to pause
   * @returns {void}
   */
  pauseJob(id: string): void {
    this.updateJob(id, { enabled: false })
    this.notifyJobStateChange(id)
  }

  /**
   * Resume a paused job by ID (sets enabled=true).
   * Resets job timing to prevent frame accumulation.
   * Notifies any subscribed state listeners.
   * @param {string} id - The job ID to resume
   * @returns {void}
   */
  resumeJob(id: string): void {
    this.updateJob(id, { enabled: true })
    this.notifyJobStateChange(id)
  }

  //* Frame Loop Control Methods ================================

  /**
   * Force the requestAnimationFrame loop to run continuously for every root,
   * clearing any paused state from a previous {@link Scheduler.stop}.
   * Root lifecycle modes resume control after stop() or the last root is removed.
   * @returns {void}
   */
  start(): void {
    this.paused = false
    this.forceRunning = true
    this.startLoop()
  }

  /**
   * Start the shared RAF driver without overriding root lifecycle selection.
   * @returns {void}
   * @private
   */
  private startLoop(): void {
    if (this.loopState.running) return

    // lastTime starts null so the first frame after a (re)start reports a zero
    // driver delta. Seeding it from performance.now() assumed that clock agrees
    // with the timestamps the driver is fed, which holds for RAF in a browser but
    // not for injected timestamps — and a bogus interval there becomes a bogus
    // delta cap, letting a waking root teleport.
    //
    // No pause compensation needed either: elapsed time is accumulated per root
    // from the deltas it actually received, so a stopped span is excluded by
    // construction rather than subtracted after the fact.
    Object.assign(this.loopState, {
      running: true,
      elapsedTime: this.loopState.elapsedTime ?? 0,
      lastTime: null,
      frameCount: 0,
      rafHandle: requestAnimationFrame(this.loop),
    })
  }

  /**
   * Stop the requestAnimationFrame loop and hold it stopped.
   *
   * Root lifecycle events — registration, unregistration, and mode changes —
   * will NOT restart the driver while stopped. Only an explicit
   * {@link Scheduler.start}, {@link Scheduler.invalidate}, or
   * {@link Scheduler.invalidateRoot} resumes it, since those are direct requests
   * for frames. Manual {@link Scheduler.step} / {@link Scheduler.stepRoot} still
   * work while stopped.
   * @returns {void}
   */
  stop(): void {
    this.paused = true
    this.forceRunning = false
    this.stopLoop()
  }

  /**
   * Stop the shared RAF driver without changing its override policy.
   * @returns {void}
   * @private
   */
  private stopLoop(): void {
    if (!this.loopState.running) return

    this.loopState.running = false
    if (this.loopState.rafHandle !== null) {
      cancelAnimationFrame(this.loopState.rafHandle)
      this.loopState.rafHandle = null
    }
  }

  /**
   * Set the frame policy for one root.
   * @param {string} rootId - Root to update
   * @param {Frameloop} mode - New frame policy
   * @returns {void}
   */
  setRootFrameloop(rootId: string, mode: Frameloop): void {
    const root = this.roots.get(rootId)
    if (!root) {
      console.warn(`[Scheduler] Root "${rootId}" not found; frameloop not updated.`)
      return
    }

    // Always reconcile, even when the mode is unchanged, so this can never leave
    // the driver out of sync with aggregate root state.
    this.applyRootFrameloop(root, mode)
    this.reconcileLoop()
  }

  /**
   * Set one root's execution order. Lower runs first; ties keep registration order.
   *
   * Registration order alone isn't stable — Suspense, conditional rendering, and
   * remounts can reverse it — so roots that share a renderer and must draw in a
   * fixed sequence should say so explicitly.
   * @param {string} rootId - Root to update
   * @param {number} order - New order value (default for roots is 0)
   * @returns {void}
   */
  setRootOrder(rootId: string, order: number): void {
    const root = this.roots.get(rootId)
    if (!root) {
      console.warn(`[Scheduler] Root "${rootId}" not found; order not updated.`)
      return
    }

    if (root.order === order) return
    root.order = order
    this.rootsNeedSort = true
  }

  /**
   * Roots in execution order, sorted lazily and cached until the set of roots or
   * their order changes — never per frame.
   * @returns {RootEntry[]} Roots in the order they should run
   * @private
   */
  private getExecutionRoots(): RootEntry[] {
    if (this.rootsNeedSort) {
      this.sortedRoots = Array.from(this.roots.values()).sort((a, b) =>
        a.order !== b.order ? a.order - b.order : a.sequence - b.sequence,
      )
      this.rootsNeedSort = false
    }
    return this.sortedRoots
  }

  /**
   * Request frames for every demand root.
   * Each root owns an independent pending count capped at 60.
   * @param {number} [frames=1] - Number of frames to request
   * @param {boolean} [stackFrames=false] - Whether to add frames to existing pending count
   *   - `false` (default): Sets pending frames to the specified value (replaces existing count)
   *   - `true`: Adds frames to existing pending count (useful for accumulating invalidations)
   * @returns {void}
   * @example
   * // Request a single frame render
   * scheduler.invalidate();
   *
   * @example
   * // Request 5 frames (e.g., for animations)
   * scheduler.invalidate(5);
   *
   * @example
   * // Set pending frames to exactly 3 (don't stack with existing)
   * scheduler.invalidate(3, false);
   *
   * @example
   * // Add 2 more frames to existing pending count
   * scheduler.invalidate(2, true);
   */
  invalidate(frames: number = 1, stackFrames: boolean = false): void {
    let invalidated = false

    for (const root of this.roots.values()) {
      if (root.frameloop !== 'demand') continue
      this.requestRootFrames(root, frames, stackFrames)
      invalidated = true
    }

    if (!invalidated) return

    // An explicit frame request overrides a previous stop().
    this.paused = false
    this.reconcileLoop()
  }

  /**
   * Request frames for one demand root.
   * @param {string} rootId - Root to invalidate
   * @param {number} [frames=1] - Number of frames to request
   * @param {boolean} [stackFrames=false] - Whether to add to the pending count
   * @returns {void}
   */
  invalidateRoot(rootId: string, frames: number = 1, stackFrames: boolean = false): void {
    const root = this.roots.get(rootId)
    if (!root) {
      console.warn(`[Scheduler] Root "${rootId}" not found; invalidation ignored.`)
      return
    }
    if (root.frameloop !== 'demand') return

    this.requestRootFrames(root, frames, stackFrames)
    // An explicit frame request overrides a previous stop().
    this.paused = false
    this.reconcileLoop()
  }

  /**
   * Reset timing state for deterministic testing.
   * Preserves jobs and roots but clears the driver's frame counters and every
   * root's accumulated time, so the next frame starts from zero.
   * @returns {void}
   */
  resetTiming(): void {
    this.loopState.lastTime = null
    this.loopState.frameCount = 0
    this.loopState.elapsedTime = 0

    for (const root of this.roots.values()) {
      root.lastTickTime = null
      root.accumulatedTime = 0
    }
  }

  //* Manual Stepping Methods ================================

  /**
   * Manually execute a single frame for all roots.
   * Useful for frameloop='never' mode or testing scenarios.
   * @param {number} [timestamp] - Optional timestamp (defaults to performance.now())
   * @returns {void}
   * @example
   * // Manual control mode
   * scheduler.frameloop = 'never';
   * scheduler.step(); // Execute one frame
   */
  step(timestamp?: number): void {
    const now = timestamp ?? performance.now()
    this.executeFrame(now)
  }

  /**
   * Manually execute a single frame for ONE root, leaving its siblings untouched.
   *
   * This is the targeted form of {@link Scheduler.step}, for hosts driving a
   * `never` root from their own loop (e.g. a WebXR animation loop) while other
   * roots stay on the shared RAF driver — stepping all roots there would tick
   * those siblings twice per frame.
   *
   * Like `step()`, it runs global before/after jobs and does NOT consume a
   * pending demand frame.
   * @param {string} rootId - The root to execute
   * @param {number} [timestamp] - Optional timestamp (defaults to performance.now())
   * @returns {void}
   * @example
   * scheduler.registerRoot('xr', { frameloop: 'never' })
   * renderer.xr.setAnimationLoop((time) => scheduler.stepRoot('xr', time))
   */
  stepRoot(rootId: string, timestamp?: number): void {
    const root = this.roots.get(rootId)
    if (!root) {
      console.warn(`[Scheduler] Root "${rootId}" not found; step ignored.`)
      return
    }

    this.executeFrame(timestamp ?? performance.now(), [root])
  }

  /**
   * Manually execute a single job by its ID.
   * Useful for testing individual job callbacks in isolation.
   * @param {string} id - The job ID to step
   * @param {number} [timestamp] - Optional timestamp (defaults to performance.now())
   * @returns {void}
   */
  stepJob(id: string, timestamp?: number): void {
    // Find the job and its root
    const root = this.findRootForJob(id)
    const job = root?.jobs.get(id)

    if (!job || !root) {
      console.warn(`[Scheduler] Job "${id}" not found`)
      return
    }

    const now = timestamp ?? performance.now()
    const driverDelta = this.loopState.lastTime !== null ? (now - this.loopState.lastTime) / 1000 : 0
    // Reported, not committed: stepping one job in isolation must not advance the
    // root's frame clock and shrink the delta its next real frame receives.
    const delta = this.computeRootDelta(root, now, driverDelta)
    const providedState = root.getState?.() ?? {}

    const frameState = {
      ...providedState,
      time: now,
      delta,
      elapsed: root.accumulatedTime,
      frame: this.loopState.frameCount,
    } as FrameNextState

    try {
      job.callback(frameState, delta)
    } catch (error) {
      console.error(`[Scheduler] Error in job "${job.id}":`, error)
      this.triggerError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  //* Core Loop Execution Methods ================================

  /**
   * Main RAF loop callback.
   * Executes frame, handles demand mode, and schedules next frame.
   * @param {number} timestamp - RAF timestamp in milliseconds
   * @returns {void}
   * @private
   */
  private loop = (timestamp: number): void => {
    if (!this.loopState.running) return

    this.executeFrame(timestamp, this.forceRunning ? 'all' : 'automatic')
    if (!this.loopState.running) return

    if (!this.forceRunning && !this.hasAutomaticWork()) {
      this.notifyIdle(timestamp)
      this.stopLoop()
      return
    }

    // Schedule next frame
    this.loopState.rafHandle = requestAnimationFrame(this.loop)
  }

  /**
   * Execute a single frame across a selection of roots.
   * Order: globalBefore → each root's jobs → globalAfter
   * @param {number} timestamp - RAF timestamp in milliseconds
   * @param {'all' | 'automatic' | RootEntry[]} [execution] - Which roots run:
   *   every root, only those with automatic work, or an explicit list.
   * @returns {void}
   * @private
   */
  private executeFrame(timestamp: number, execution: 'all' | 'automatic' | RootEntry[] = 'all'): void {
    // Snapshot root eligibility at the frame boundary so callback invalidations
    // cannot make later roots run in the same frame based on registration order.
    // getExecutionRoots() returns a cached array that is replaced, never mutated,
    // when roots change — so an in-flight frame keeps iterating its own snapshot.
    const frameRoots =
      execution === 'automatic'
        ? this.collectAutomaticRoots()
        : execution === 'all'
          ? this.getExecutionRoots()
          : execution

    // Update timing (RAF provides ms, convert delta to seconds for consistency with legacy THREE.Clock)
    // Handle first frame case where lastTime is null - use timestamp as base (delta = 0)
    const deltaMs = this.loopState.lastTime !== null ? timestamp - this.loopState.lastTime : 0
    const delta = deltaMs / 1000 // Convert to seconds
    this.loopState.lastTime = timestamp
    this.loopState.frameCount++
    this.loopState.elapsedTime += deltaMs // Keep elapsed in ms for internal tracking

    // 1. Run globalBefore jobs (addEffect)
    this.runGlobalJobs(this.globalBeforeJobs, timestamp)

    // 2. For each root, run its jobs
    for (const root of frameRoots) {
      // A preceding callback may have removed a root after the frame snapshot.
      if (this.roots.get(root.id) !== root) continue
      this.tickRoot(root, timestamp, delta)
    }

    // 3. Run globalAfter jobs (addAfterEffect)
    this.runGlobalJobs(this.globalAfterJobs, timestamp)
  }

  /**
   * Run all global jobs from a job map.
   * Catches and logs errors without stopping execution.
   * @param {Map<string, GlobalJob>} jobs - The global jobs map to execute
   * @param {number} timestamp - RAF timestamp in milliseconds
   * @returns {void}
   * @private
   */
  private runGlobalJobs(jobs: Map<string, GlobalJob>, timestamp: number): void {
    for (const job of jobs.values()) {
      try {
        job.callback(timestamp)
      } catch (error) {
        console.error(`[Scheduler] Error in global job "${job.id}":`, error)
      }
    }
  }

  /**
   * Execute all jobs for a single root in sorted order.
   * Rebuilds sorted job list if needed, then dispatches each job.
   * Errors are caught and propagated via triggerError.
   * @param {RootEntry} root - The root entry to tick
   * @param {number} timestamp - RAF timestamp in milliseconds
   * @param {number} driverDelta - Time since the driver's last frame in seconds
   * @returns {void}
   * @private
   */
  private tickRoot(root: RootEntry, timestamp: number, driverDelta: number): void {
    // Rebuild if needed
    if (root.needsRebuild) {
      root.sortedJobs = rebuildSortedJobs(root.jobs, this.phaseGraph)
      root.needsRebuild = false
    }

    const delta = this.computeRootDelta(root, timestamp, driverDelta)
    root.lastTickTime = timestamp
    root.accumulatedTime += delta

    const providedState = root.getState?.() ?? {}

    // Build frame state. delta/elapsed belong to this root; time/frame are the
    // driver's, shared by every root running on the same frame.
    const frameState = {
      ...providedState,
      time: timestamp,
      delta,
      elapsed: root.accumulatedTime,
      frame: this.loopState.frameCount,
    } as FrameNextState

    // Dispatch jobs
    for (const job of root.sortedJobs) {
      if (!shouldRun(job, timestamp)) continue

      // A throttled job skips frames, so the root delta understates how much time
      // passed for it — an fps:30 job in a 60fps root would be told 16ms every
      // 33ms and run at half speed. Differencing the root's accumulated time gives
      // the real interval, and inherits the root's sleep cap for free.
      const jobDelta = job.lastRunElapsed === undefined ? delta : root.accumulatedTime - job.lastRunElapsed
      job.lastRunElapsed = root.accumulatedTime

      const jobState = jobDelta === delta ? frameState : ({ ...frameState, delta: jobDelta } as FrameNextState)

      try {
        job.callback(jobState, jobDelta)
      } catch (error) {
        console.error(`[Scheduler] Error in job "${job.id}":`, error)
        // Propagate error via pluggable handler
        this.triggerError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  /**
   * Compute the delta a root should receive this tick.
   *
   * Measured from the root's own last tick, so a root that skipped frames isn't
   * told it ran continuously — then capped, so one that slept resumes instead of
   * fast-forwarding. The cap defaults to a single driver frame, which makes this
   * identical to the driver delta for any root that runs every frame, and
   * self-tunes across refresh rates. `maxDelta: Infinity` opts into wall-clock
   * catch-up.
   * @param {RootEntry} root - The root about to tick
   * @param {number} timestamp - Frame timestamp in milliseconds
   * @param {number} driverDelta - Time since the driver's last frame in seconds
   * @returns {number} Delta in seconds, never negative
   * @private
   */
  private computeRootDelta(root: RootEntry, timestamp: number, driverDelta: number): number {
    if (root.lastTickTime === null) return 0

    const rawDelta = (timestamp - root.lastTickTime) / 1000
    return Math.max(0, Math.min(rawDelta, root.maxDelta ?? driverDelta))
  }

  /**
   * Apply a root mode without reconciling the shared driver.
   *
   * Entering demand does NOT grant a frame: a demand root draws only when
   * invalidated, whether it was registered in demand mode or switched into it.
   * Hosts that need a frame on the transition should call
   * {@link Scheduler.invalidateRoot} themselves. Leaving demand clears pending
   * frames so stale work can't run on a later return.
   * @param {RootEntry} root - Root to update
   * @param {Frameloop} mode - New frame policy
   * @returns {boolean} Whether the root changed
   * @private
   */
  private applyRootFrameloop(root: RootEntry, mode: Frameloop): boolean {
    if (root.frameloop === mode) return false

    root.frameloop = mode
    if (mode !== 'demand') root.pendingFrames = 0
    return true
  }

  /**
   * Update one root's pending-frame count.
   * @param {RootEntry} root - Demand root to invalidate
   * @param {number} frames - Requested frame count
   * @param {boolean} stackFrames - Add to or replace the current count
   * @returns {void}
   * @private
   */
  private requestRootFrames(root: RootEntry, frames: number, stackFrames: boolean): void {
    const baseFrames = stackFrames ? root.pendingFrames : 0
    root.pendingFrames = Math.min(60, Math.max(0, baseFrames + frames))
  }

  /**
   * Check whether a root should execute on an automatically driven frame.
   * @param {RootEntry} root - Root to inspect
   * @returns {boolean} True when the root has automatic work
   * @private
   */
  private shouldTickRoot(root: RootEntry): boolean {
    return root.frameloop === 'always' || (root.frameloop === 'demand' && root.pendingFrames > 0)
  }

  /**
   * Snapshot roots eligible for the next automatic frame and consume demand tokens.
   * @returns {RootEntry[]} Roots that should execute in registration order
   * @private
   */
  private collectAutomaticRoots(): RootEntry[] {
    const frameRoots: RootEntry[] = []

    for (const root of this.getExecutionRoots()) {
      if (!this.shouldTickRoot(root)) continue
      if (root.frameloop === 'demand') root.pendingFrames--
      frameRoots.push(root)
    }

    return frameRoots
  }

  /**
   * Check whether any root requires the shared RAF driver.
   * @returns {boolean} True when automatic work exists
   * @private
   */
  private hasAutomaticWork(): boolean {
    for (const root of this.roots.values()) {
      if (this.shouldTickRoot(root)) return true
    }
    return false
  }

  /**
   * Start or stop the shared RAF driver from aggregate root state.
   * No-op while paused by an explicit {@link Scheduler.stop}, so routine
   * lifecycle events can't silently resurrect a stopped driver.
   * @returns {void}
   * @private
   */
  private reconcileLoop(): void {
    if (this.paused) return
    if (this.forceRunning || this.hasAutomaticWork()) this.startLoop()
    else this.stopLoop()
  }

  //* Debug & Inspection Methods ================================

  /**
   * Get the total number of registered jobs across all roots.
   * Includes both per-root jobs and global before/after jobs.
   * @returns {number} Total job count
   */
  getJobCount(): number {
    let count = 0
    for (const root of this.roots.values()) {
      count += root.jobs.size
    }
    return count + this.globalBeforeJobs.size + this.globalAfterJobs.size
  }

  /**
   * Get all registered job IDs across all roots.
   * Includes both per-root jobs and global before/after jobs.
   * @returns {string[]} Array of all job IDs
   */
  getJobIds(): string[] {
    const ids: string[] = []
    for (const root of this.roots.values()) {
      ids.push(...root.jobs.keys())
    }
    ids.push(...this.globalBeforeJobs.keys())
    ids.push(...this.globalAfterJobs.keys())
    return ids
  }

  /**
   * Get the number of registered roots.
   * @returns {number} Number of registered roots
   */
  getRootCount(): number {
    return this.roots.size
  }

  /**
   * Get all registered root IDs in execution order (see {@link Scheduler.setRootOrder}).
   * With no explicit ordering this is registration order.
   * @returns {string[]} Array of root IDs
   */
  getRootIds(): string[] {
    return this.getExecutionRoots().map((root) => root.id)
  }

  /**
   * Read one root's lifecycle mode.
   * @param {string} rootId - The root to inspect
   * @returns {Frameloop | undefined} The mode, or undefined if the root is unknown
   */
  getRootFrameloop(rootId: string): Frameloop | undefined {
    return this.roots.get(rootId)?.frameloop
  }

  /**
   * Find which root currently owns a job.
   *
   * Resolve this at call time rather than caching it: ambient-root adoption
   * moves jobs between roots, so an id captured at registration goes stale.
   * @param {string} jobId - The job to look up
   * @returns {string | undefined} The owning root ID, or undefined if not found
   * @see docs/design/ambient-root.md
   */
  getJobRootId(jobId: string): string | undefined {
    return this.findRootForJob(jobId)?.id
  }

  /**
   * Check if any user (non-system) jobs are registered in a specific phase.
   * Used by the default render job to know if a user has taken over rendering.
   *
   * @param phase The phase to check
   * @param rootId Optional root ID to check (checks all roots if not provided)
   * @returns true if any user jobs exist in the phase
   */
  hasUserJobsInPhase(phase: string, rootId?: string): boolean {
    const rootsToCheck = rootId ? [this.roots.get(rootId)].filter(Boolean) : Array.from(this.roots.values())

    // Early return pattern: stops iteration as soon as a match is found
    return rootsToCheck.some((root) => {
      if (!root) return false
      // Check if any job in this root matches criteria
      for (const job of root.jobs.values()) {
        if (job.phase === phase && !job.system && job.enabled) return true
      }
      return false
    })
  }

  //* Utility Methods ================================

  /**
   * Find the root entry containing a job.
   * @param {string} jobId - The job ID to search for
   * @returns {RootEntry | undefined} The owning root, or undefined if not found
   * @private
   */
  private findRootForJob(jobId: string): RootEntry | undefined {
    for (const root of this.roots.values()) {
      if (root.jobs.has(jobId)) return root
    }
    return undefined
  }

  /**
   * Generate a unique root ID for automatic root registration.
   * @returns {string} A unique root ID in the format 'root_N'
   */
  generateRootId(): string {
    return `root_${this.nextRootIndex++}`
  }

  /**
   * Generate a unique job ID.
   * @returns {string} A unique job ID in the format 'job_N'
   * @private
   */
  private generateJobId(): string {
    return `job_${this.nextJobIndex}`
  }

  /**
   * Derive the phase for a job that declared `before`/`after` without one.
   *
   * Three tiers, because the target can be either kind of name:
   * 1. A **phase** — auto-generate the `before:`/`after:` slot around it.
   * 2. A **job id** — adopt that job's phase and let the sorter's job-to-job
   *    ordering position them within it.
   * 3. Neither — warn and default to `update`.
   *
   * Tier 3 previously fell through to the phase graph, which appended an invented
   * phase to the end of the global order: the job ran after `finish` instead of
   * where it asked, and the junk phase persisted for every root.
   * @param {string | string[]} [before] - Before constraint(s)
   * @param {string | string[]} [after] - After constraint(s)
   * @returns {string} The phase to place this job in
   * @private
   */
  private resolveConstraintPhase(before?: string | string[], after?: string | string[]): string {
    // Mirror PhaseGraph's precedence: the first `before` wins, else the first `after`.
    const first = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value)
    const target = first(before) ?? first(after)
    if (!target) return 'update'

    if (this.phaseGraph.hasPhase(target)) {
      return this.phaseGraph.resolveConstraintPhase(before, after)
    }

    const targetJob = this.findRootForJob(target)?.jobs.get(target)
    if (targetJob) return targetJob.phase

    console.warn(
      `[Scheduler] "${target}" is neither a phase nor a registered job; ` +
        `defaulting to the "update" phase. Register the target first, or pass an explicit phase.`,
    )
    return 'update'
  }

  /**
   * Normalize before/after constraints to a Set.
   * Handles undefined, single string, or array inputs.
   * @param {string | string[] | undefined} value - The constraint value(s)
   * @returns {Set<string>} Normalized Set of constraint strings
   * @private
   */
  private normalizeConstraints(value?: string | string[]): Set<string> {
    if (!value) return new Set()
    if (Array.isArray(value)) return new Set(value)
    return new Set([value])
  }
}

//* Export Global Scheduler Getter ==============================

/**
 * Get the global scheduler instance.
 * Creates one if it doesn't exist.
 */
export const getScheduler = (): Scheduler => Scheduler.get()

//* HMR Accept ==============================
// Accept hot updates to preserve scheduler state
if (hmrData) {
  hmrData.accept?.()
}
