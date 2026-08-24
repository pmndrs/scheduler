//* @pmndrs/scheduler — Public & Internal Types ==============================
//
// These were ambient `declare global` interfaces and r3f-coupled `.d.ts` files
// inside react-three-fiber. Here they are plain exported types with no React,
// no three, and no RootState. Consumers that want typed frame state parameterize
// `FrameCallback<T>` (r3f passes `T = RootState`).

//* Frame Loop Mode --------------------------------

/** Frame loop mode: run every frame, on demand (invalidate), or never (manual step) */
export type Frameloop = 'always' | 'demand' | 'never'

//* Public Options --------------------------------

/** Options for the `useFrame` hook / `scheduler.register` */
export interface UseFrameOptions {
  /** Optional stable id for the job. Auto-generated if not provided */
  id?: string
  /** Named phase to run in. Default: 'update' */
  phase?: string
  /** Run before this phase or job id */
  before?: string | string[]
  /** Run after this phase or job id */
  after?: string | string[]
  /** Priority within phase. Higher runs first. Default: 0 */
  priority?: number
  /** Max frames per second for this job */
  fps?: number
  /** If true, skip frames when behind. If false, try to catch up. Default: true */
  drop?: boolean
  /** Enable/disable without unregistering. Default: true */
  enabled?: boolean
}

/** Backwards-compatible alias */
export type UseFrameNextOptions = UseFrameOptions

/** Options for `scheduler.addPhase` */
export interface AddPhaseOptions {
  /** Insert this phase before the specified phase */
  before?: string
  /** Insert this phase after the specified phase */
  after?: string
}

//* Frame State --------------------------------

/**
 * Timing-only state passed to every frame callback.
 */
export interface FrameTimingState {
  /** High-resolution timestamp from RAF (ms) */
  time: number
  /** Time since last frame in seconds (for compatibility with THREE.Clock) */
  delta: number
  /** Elapsed time since first frame in seconds (for compatibility with THREE.Clock) */
  elapsed: number
  /** Incrementing frame counter */
  frame: number
}

/**
 * Full frame state: timing plus any state a root injects via `getState`.
 * Generic so consumers (e.g. r3f) can supply their own root state type.
 */
export type FrameState<T = unknown> = FrameTimingState & T

/** Default (timing-only) frame state. Backwards-compatible alias. */
export type FrameNextState = FrameTimingState

//* Callbacks --------------------------------

/**
 * Frame callback. By default it receives timing-only state; pass a type argument
 * to type the injected root state (`FrameCallback<RootState>`).
 */
export type FrameCallback<T = FrameTimingState> = (state: T & FrameTimingState, delta: number) => void

/** Backwards-compatible alias */
export type FrameNextCallback = FrameCallback

//* Root Options --------------------------------

/** Options for `scheduler.registerRoot` */
export interface RootOptions {
  /** State provider for callbacks. Optional for hostless (standalone) roots. */
  getState?: () => any
  /** Error handler for job errors. Falls back to console.error if not provided. */
  onError?: (error: Error) => void
  /** Root frame policy. Defaults to the scheduler's current frameloop setting. */
  frameloop?: Frameloop
  /**
   * Execution order relative to other roots. Lower runs first; ties fall back to
   * registration order. Defaults to `0`.
   *
   * Use this when roots share a renderer and one must draw before another —
   * registration order alone is not stable under Suspense, conditional rendering,
   * or remounts.
   */
  order?: number
  /** Run this root before the referenced root id(s). */
  before?: string | string[]
  /** Run this root after the referenced root id(s). */
  after?: string | string[]
  /**
   * Largest delta (in seconds) this root's callbacks can receive, capping how far
   * it catches up after skipping frames.
   *
   * Defaults to one driver frame, so a root that slept resumes where it left off
   * instead of fast-forwarding. Raise it to allow bounded catch-up, or set
   * `Infinity` for true wall-clock deltas (v9 `THREE.Clock` behavior).
   */
  maxDelta?: number
}

//* Controls returned from useFrame --------------------------------

/** Controls object returned from the `useFrame` hook */
export interface FrameControls {
  /** The job's unique ID */
  id: string
  /** Access to the global scheduler for frame loop control */
  scheduler: SchedulerApi
  /**
   * The root that currently owns this job, or undefined if it isn't registered.
   * Resolved on access, because host adoption can move a job between roots.
   */
  readonly rootId: string | undefined
  /** Manually step this job only (bypasses FPS limiting) */
  step(timestamp?: number): void
  /** Manually step ALL jobs in the scheduler */
  stepAll(timestamp?: number): void
  /**
   * Request frames for the root that owns this job. No-op when that root isn't
   * in demand mode, or when this job isn't registered to a root.
   */
  invalidate(frames?: number, stackFrames?: boolean): void
  /** Pause this job (set enabled=false) */
  pause(): void
  /** Resume this job (set enabled=true) */
  resume(): void
  /** Reactive paused state - automatically triggers re-render when changed */
  isPaused: boolean
}

/** Backwards-compatible alias */
export type FrameNextControls = FrameControls

//* Scheduler Public Interface --------------------------------

/** Public interface for the global Scheduler */
export interface SchedulerApi {
  //* Phase Management
  addPhase(name: string, options?: AddPhaseOptions): void
  readonly phases: string[]
  hasPhase(name: string): boolean

  //* Root Management
  registerRoot(id: string, options?: RootOptions): () => void
  unregisterRoot(id: string): void
  generateRootId(): string
  getRootCount(): number
  getRootIds(): string[]
  getRootFrameloop(rootId: string): Frameloop | undefined
  getJobRootId(jobId: string): string | undefined
  readonly isReady: boolean
  onRootReady(callback: () => void): () => void

  //* Job Registration
  register<T = FrameTimingState>(
    callback: FrameCallback<T>,
    options?: JobOptions & { rootId?: string; system?: boolean },
  ): () => void
  updateJob(id: string, options: Partial<JobOptions>): void
  unregister(id: string, rootId?: string): void
  getJobCount(): number
  getJobIds(): string[]

  //* Global Jobs (for legacy addEffect/addAfterEffect bridges)
  registerGlobal(phase: 'before' | 'after', id: string, callback: (timestamp: number) => void): () => void

  //* Idle Callbacks (for legacy addTail bridge)
  onIdle(callback: (timestamp: number) => void): () => void

  //* Frame Loop Control
  start(): void
  stop(): void
  readonly isRunning: boolean
  frameloop: Frameloop
  defaultFrameloop: Frameloop
  setRootFrameloop(rootId: string, mode: Frameloop): void
  setRootOrder(rootId: string, order: number): void
  setRootConstraints(rootId: string, constraints: Pick<RootOptions, 'before' | 'after'>): void

  //* Manual Stepping
  step(timestamp?: number): void
  stepRoot(rootId: string, timestamp?: number): void
  stepJob(id: string, timestamp?: number): void
  invalidate(frames?: number, stackFrames?: boolean): void
  invalidateRoot(rootId: string, frames?: number, stackFrames?: boolean): void

  //* Per-Job Control
  isJobPaused(id: string): boolean
  pauseJob(id: string): void
  resumeJob(id: string): void
  subscribeJobState(id: string, listener: () => void): () => void
}

//* Internal Types (exported for cross-module use, not part of the stable API) ===

/**
 * Internal job representation in the scheduler.
 * @internal
 */
export interface Job {
  /** Unique identifier */
  id: string
  /** The callback to execute (state shape is the registrant's responsibility) */
  callback: FrameCallback<any>
  /** Phase this job belongs to */
  phase: string
  /** Run before these phases/job ids */
  before: Set<string>
  /** Run after these phases/job ids */
  after: Set<string>
  /** Priority within phase (higher first) */
  priority: number
  /** Insertion order for deterministic tie-breaking */
  index: number
  /** Max FPS for this job (undefined = no limit) */
  fps?: number
  /** Drop frames when behind (true) or catch up (false) */
  drop: boolean
  /** Last run timestamp (ms) */
  lastRun?: number
  /**
   * The owning root's `accumulatedTime` when this job last ran, in seconds.
   * Differencing against it yields the time the root experienced since — which is
   * the job's real delta when throttling made it skip frames, and excludes any
   * span the root slept through.
   */
  lastRunElapsed?: number
  /** Whether job is enabled */
  enabled: boolean
  /** Internal flag: system jobs (like a default render) don't block user takeover */
  system?: boolean
}

/**
 * A node in the phase graph.
 * @internal
 */
export interface PhaseNode {
  /** Phase name */
  name: string
  /** Whether this was auto-generated from a before/after constraint */
  isAutoGenerated: boolean
}

/**
 * Options for creating a job from hook options.
 * @internal
 */
export interface JobOptions {
  id?: string
  phase?: string
  before?: string | string[]
  after?: string | string[]
  priority?: number
  fps?: number
  drop?: boolean
  enabled?: boolean
}

/**
 * Internal frame loop state.
 * @internal
 */
export interface FrameLoopState {
  /** Whether the loop is running */
  running: boolean
  /** Current RAF handle */
  rafHandle: number | null
  /** Last shared RAF/global-step timestamp in ms; targeted steps never write it */
  lastTime: number | null
  /** Most recent positive shared frame interval in seconds, retained across RAF restarts */
  lastFrameDelta: number | null
  /** Shared RAF/global-step frame counter */
  frameCount: number
  /**
   * Driver running time in ms. Not what callbacks receive — frame state carries
   * the owning root's own accumulated time, which excludes frames it slept through.
   * Targeted root steps do not advance this shared clock.
   */
  elapsedTime: number
}

/**
 * Internal representation of a registered root.
 * @internal
 */
export interface RootEntry {
  /** Unique identifier for this root */
  id: string
  /** Function to get the root's current state. Returns any to support hostless roots. */
  getState: () => any
  /** Map of job IDs to Job objects */
  jobs: Map<string, Job>
  /** Cached sorted job list for execution order */
  sortedJobs: Job[]
  /** Whether sortedJobs needs rebuilding */
  needsRebuild: boolean
  /** Frame policy for this root */
  frameloop: Frameloop
  /** Demand frames waiting to be executed */
  pendingFrames: number
  /** Execution order; lower runs first, ties broken by `sequence` */
  order: number
  /** Registration sequence, for stable ordering between equal `order` values */
  sequence: number
  /** Root ids this root must execute before */
  before: Set<string>
  /** Root ids this root must execute after */
  after: Set<string>
  /** Timestamp of this root's last tick in ms (null = never ticked) */
  lastTickTime: number | null
  /** Sum of the deltas this root has received, in seconds */
  accumulatedTime: number
  /** Delta cap in seconds. undefined = one driver frame */
  maxDelta: number | undefined
}

/**
 * Internal representation of a global job (deprecated API).
 * @internal
 */
export interface GlobalJob {
  /** Unique identifier for this global job */
  id: string
  /** Callback invoked with RAF timestamp in ms */
  callback: (timestamp: number) => void
}

/**
 * Hot Module Replacement data structure for preserving scheduler state.
 * @internal
 */
export interface HMRData {
  /** Shared data object for storing values across reloads */
  data: Record<string, any>
  /** Optional function to accept HMR updates */
  accept?: () => void
}

/** Default phase names for the scheduler */
export type DefaultPhase = 'start' | 'input' | 'physics' | 'update' | 'render' | 'finish'
