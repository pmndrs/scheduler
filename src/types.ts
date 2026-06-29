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
  /** State provider for callbacks. Optional in independent mode. */
  getState?: () => any
  /** Error handler for job errors. Falls back to console.error if not provided. */
  onError?: (error: Error) => void
}

//* Controls returned from useFrame --------------------------------

/** Controls object returned from the `useFrame` hook */
export interface FrameControls {
  /** The job's unique ID */
  id: string
  /** Access to the global scheduler for frame loop control */
  scheduler: SchedulerApi
  /** Manually step this job only (bypasses FPS limiting) */
  step(timestamp?: number): void
  /** Manually step ALL jobs in the scheduler */
  stepAll(timestamp?: number): void
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
  independent: boolean

  //* Manual Stepping
  step(timestamp?: number): void
  stepJob(id: string, timestamp?: number): void
  invalidate(frames?: number, stackFrames?: boolean): void

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
  /** Last frame timestamp in ms (null = uninitialized) */
  lastTime: number | null
  /** Frame counter */
  frameCount: number
  /** Elapsed time since first frame in ms */
  elapsedTime: number
  /** createdAt timestamp in ms */
  createdAt: number
}

/**
 * Internal representation of a registered root.
 * @internal
 */
export interface RootEntry {
  /** Unique identifier for this root */
  id: string
  /** Function to get the root's current state. Returns any to support independent mode. */
  getState: () => any
  /** Map of job IDs to Job objects */
  jobs: Map<string, Job>
  /** Cached sorted job list for execution order */
  sortedJobs: Job[]
  /** Whether sortedJobs needs rebuilding */
  needsRebuild: boolean
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
