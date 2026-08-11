# Scheduler API Reference

The `Scheduler` is a global singleton that manages the frame loop and job execution. It is
framework-agnostic: react-three-fiber drives it through `useFrame`, but you can use it
directly from any JavaScript app.

## Overview

**Features:**

- A single `requestAnimationFrame` loop for the entire application
- Multi-root support (multiple hosts/canvases share one loop)
- Phase-based execution order with dynamic phase creation
- Priority-based sorting within phases
- Per-job FPS throttling with drop/catch-up semantics
- Pause/resume individual jobs
- Manual stepping for testing and `frameloop='never'`
- Per-root `always`, `demand`, and `never` lifecycle modes
- Root-scoped and fan-out invalidation

## Architecture

```
Global Scheduler (RAF loop)
├── globalBefore jobs (registerGlobal 'before')
├── For each registered root:
│   ├── start phase
│   ├── input phase
│   ├── physics phase
│   ├── update phase (default)
│   ├── render phase
│   └── finish phase
├── globalAfter jobs (registerGlobal 'after')
└── onIdle callbacks (when the loop stops in demand mode)
```

## Getting the instance

```ts
import { getScheduler } from '@pmndrs/scheduler'

const scheduler = getScheduler()
```

The instance is shared across bundles via `Symbol.for('@pmndrs/scheduler')`, so mixing
imports (e.g. your app + react-three-fiber) always resolves to the **same** scheduler.

In React you can also reach it through the hook:

```tsx
import { useFrame } from '@pmndrs/scheduler/react'

const { scheduler } = useFrame()
```

---

## Standalone (no host)

Run the scheduler without any host (no Canvas, no renderer) — **no setup required**. The
first `register` (or `useFrame`) lazily creates an internal **ambient root**:

```ts
getScheduler().register((state, delta) => {
  // state = { time, delta, elapsed, frame }
})
```

- The ambient root is created on demand; you never reference it directly.
- Callbacks receive timing-only [`FrameTimingState`](#type-definitions): `{ time, delta, elapsed, frame }`.
- Useful for game loops, animations, or any frame-based logic with no renderer.
- If a host registers later, it **adopts** these jobs. See
  [Ambient root & host adoption](./design/ambient-root.md).

---

## Ready state

### `isReady` (getter)

`true` if at least one root is registered.

```ts
if (scheduler.isReady) {
  /* a host has mounted */
}
```

### `onRootReady(callback)`

Subscribe to be notified when a root becomes available. Fires immediately if one already
exists. Returns an unsubscribe function.

> Note: this signals "a root exists" — which includes the lazily-created **ambient root**,
> so it fires on the first `register` even with no host attached. It is not a "host state
> ready" signal.

```ts
const unsub = scheduler.onRootReady(() => {
  console.log('a root is ready')
})
```

---

## Phase management

Default phases, in order: `start`, `input`, `physics`, `update`, `render`, `finish`.

### `addPhase(name, options?)`

Insert a named phase into the execution order.

```ts
interface AddPhaseOptions {
  before?: string // insert before this phase
  after?: string // insert after this phase
}
```

```ts
scheduler.addPhase('physics', { before: 'update' })
scheduler.addPhase('postprocess', { after: 'render' })
scheduler.addPhase('cleanup') // append to the end
```

Adding a phase marks all roots for rebuild. Duplicate names are ignored with a warning.

### `hasPhase(name): boolean`

```ts
if (scheduler.hasPhase('physics')) {
  /* ... */
}
```

### `phases` (getter): `string[]`

```ts
console.log(scheduler.phases)
// ['start', 'input', 'physics', 'update', 'render', 'finish']
```

---

## Root management

A **root** is a container for jobs. react-three-fiber registers one root per `<Canvas>`;
standalone, an ambient root is created lazily on first `register` (or call `registerRoot`
explicitly for multi-root setups).

### `registerRoot(id, options?)`

Register a root. An `always` root starts the shared RAF driver; demand and never roots stay
idle until explicitly requested. Returns an unsubscribe function.

```ts
interface RootOptions {
  getState?: () => any // state provider merged into the frame state
  onError?: (error: Error) => void // job error handler (default: console.error)
  frameloop?: 'always' | 'demand' | 'never' // defaults to scheduler.frameloop
  maxDelta?: number // delta cap in seconds; defaults to one driver frame
}
```

```ts
// With injected state — callbacks receive getState() merged with timing
const unsubscribe = scheduler.registerRoot('my-root', {
  getState: () => store.getState(),
  onError: (err) => reportError(err),
  frameloop: 'demand',
})

// Minimal — timing-only state
scheduler.registerRoot('standalone')
```

- `getState` is how a host injects its own state (r3f injects its `RootState`). Whatever it
  returns is spread into the object passed to every job callback, alongside timing.
- Roots share one RAF driver and its `time` / `frame`, but their mode, pending demand
  frames, `delta`, and `elapsed` are independent — a sleeping root doesn't accumulate time
  it never saw. `maxDelta` caps how far a root catches up after skipping frames; the default
  of one driver frame means a waking root resumes rather than jumping. See
  [Timing](./concepts.md#timing).
- The last root to unregister stops the loop.

### `setRootFrameloop(rootId, mode)`

Change one root's lifecycle mode without affecting its siblings:

```ts
scheduler.setRootFrameloop('my-root', 'demand')
```

Leaving demand mode clears that root's pending frame count. An unknown root warns and is
otherwise ignored.

### `unregisterRoot(id)`

```ts
scheduler.unregisterRoot('my-root')
```

### `generateRootId(): string`

Returns a unique id like `'root_0'`.

### `getRootCount(): number`

Number of registered roots.

### `getRootIds(): string[]`

All registered root ids, in registration order.

### `getRootFrameloop(rootId): Frameloop | undefined`

One root's current mode, or `undefined` if the root is unknown. Since `scheduler.frameloop`
only reports the default for new roots, this is how you ask what a specific root is doing.

### `getJobRootId(jobId): string | undefined`

Which root currently owns a job, or `undefined` if it isn't registered.

Resolve this at call time rather than caching it — a host adopts ambient jobs when it
registers, so an id captured earlier goes stale. @see [ambient root](./design/ambient-root.md)

---

## Job registration

### `register(callback, options?)`

Register a frame callback. This is what `useFrame` calls internally. Returns an unsubscribe
function.

```ts
type FrameCallback<T = FrameTimingState> = (state: T & FrameTimingState, delta: number) => void

interface JobOptions {
  id?: string // unique id (auto-generated if omitted)
  rootId?: string // target root (defaults to the first root)
  phase?: string // execution phase (default: 'update')
  before?: string | string[] // run before this phase or job id
  after?: string | string[] // run after this phase or job id
  priority?: number // priority within a phase (higher first, default: 0)
  fps?: number // throttle to this rate
  drop?: boolean // drop missed frames (default: true) vs catch up
  enabled?: boolean // whether the job runs (default: true)
}
```

```ts
// Basic
const unsub = scheduler.register((state, delta) => {
  console.log('frame', state.frame)
})

// With options
scheduler.register(
  (state, delta) => {
    /* physics */
  },
  { id: 'physics-sim', phase: 'physics', priority: 10, fps: 60 },
)

unsub() // cleanup
```

Typed state — pass a type argument when a root injects state:

```ts
type GameState = { player: Player }
scheduler.register<GameState>(
  (state) => {
    state.player.update(state.delta) // typed
  },
  { phase: 'update' },
)
```

Notes:

- Duplicate ids replace the existing job (with a warning).
- If `before`/`after` is set without an explicit `phase`, a phase is auto-resolved.

### `unregister(id, rootId?)`

```ts
scheduler.unregister('my-job')
```

### `updateJob(id, options)`

Update a job's options. `priority`, `fps`, `drop`, and `enabled` change in place; `phase`,
`before`, and `after` trigger a re-sort.

```ts
scheduler.updateJob('my-job', { priority: 5 })
scheduler.updateJob('my-job', { fps: 30, drop: true })
scheduler.updateJob('my-job', { phase: 'render' })
scheduler.updateJob('my-job', { enabled: false })
```

Re-enabling resets the job's timing to prevent accumulated frames.

### `getJobCount(): number` / `getJobIds(): string[]`

```ts
console.log(scheduler.getJobCount())
console.log(scheduler.getJobIds())
```

### `hasUserJobsInPhase(phase, rootId?): boolean`

`true` if any non-system, enabled job exists in a phase. react-three-fiber uses this to
detect when you've taken over the `render` phase and skip its default renderer.

```ts
if (scheduler.hasUserJobsInPhase('render')) {
  /* a user job owns rendering */
}
```

---

## Job state (pause / resume)

### `isJobPaused(id): boolean`

```ts
if (scheduler.isJobPaused('my-animation')) {
  /* ... */
}
```

### `pauseJob(id)` / `resumeJob(id)`

Pause sets `enabled=false` (the job stays registered but doesn't run); resume sets it back
and resets timing. Both notify [state subscribers](#subscribejobstateid-listener).

```ts
scheduler.pauseJob('my-animation')
scheduler.resumeJob('my-animation')
```

### `subscribeJobState(id, listener)`

Subscribe to pause/resume changes for a job. Returns an unsubscribe function. This is what
`useFrame` uses to make `isPaused` reactive.

```ts
const unsub = scheduler.subscribeJobState('my-job', () => {
  console.log('job state changed')
})
```

---

## Frame loop control

### `start()` / `stop()`

Explicitly override the automatic root lifecycle. `start()` runs every root continuously;
`stop()` cancels that override and holds the driver stopped. Normal root registration, mode
changes, and invalidation automatically manage the driver without requiring these methods.

```ts
scheduler.start()
scheduler.stop()
```

`stop()` is sticky. Routine lifecycle events — a root registering, unregistering, or
changing mode — will **not** restart the driver while stopped, so a paused app stays paused
when a new host mounts. What does resume it:

| Action                                  | Resumes?                             |
| --------------------------------------- | ------------------------------------ |
| `start()`                               | yes                                  |
| `invalidate()` / `invalidateRoot()`     | yes — an explicit request for frames |
| `registerRoot()` / `setRootFrameloop()` | no                                   |
| `scheduler.frameloop = …`               | no                                   |
| `step()` / `stepRoot()`                 | runs the frame, driver stays stopped |

### `isRunning` (getter): `boolean`

### `frameloop` (getter/setter)

`'always' | 'demand' | 'never'`

```ts
scheduler.frameloop = 'demand'
```

- `'always'` — continuous (default).
- `'demand'` — run when invalidated.
- `'never'` — run during manual stepping.

This property is the compatibility bulk control: setting it updates every existing root
and sets the default for roots registered later. The getter returns that default.

With more than one root this is last-writer-wins across hosts, so it warns once. Use
[`setRootFrameloop`](#setrootframelooprootid-mode) for per-root control, or
`defaultFrameloop` to change only the default.

### `defaultFrameloop` (getter/setter)

The mode given to roots registered without an explicit `frameloop`. Unlike `frameloop`,
setting it leaves existing roots alone.

```ts
scheduler.defaultFrameloop = 'demand'
scheduler.registerRoot('later') // starts in demand
```

### `invalidate(frames?, stackFrames?)`

Request frames for every demand root. Each root gets an independent pending count capped at 60. Always and never roots are unchanged.

```ts
scheduler.invalidate() // one frame
scheduler.invalidate(5) // five frames
scheduler.invalidate(3, false) // set pending to exactly 3
scheduler.invalidate(2, true) // add 2 to the pending count
```

Each demand root decrements its own pending count when it executes. The RAF stops and
[`onIdle`](#onidlecallback) callbacks fire when no always root or pending demand root
remains.

### `invalidateRoot(rootId, frames?, stackFrames?)`

Request frames for one demand root:

```ts
scheduler.invalidateRoot('my-root')
scheduler.invalidateRoot('my-root', 5)
scheduler.invalidateRoot('my-root', 2, true)
```

Invalidating during that root's callback schedules a subsequent frame; it is not consumed
by the frame currently executing. Calls for always and never roots are no-ops.

### `resetTiming()`

Reset the driver's frame counters and every root's accumulated time, without touching jobs
or roots themselves. Mostly for deterministic tests.

---

## Manual stepping

### `step(timestamp?)`

Execute a single frame for all roots. Synchronous — does not schedule RAF. Defaults to
`performance.now()`.

```ts
scheduler.frameloop = 'never'
scheduler.step() // run one frame
scheduler.step(16.67) // run one frame at an explicit timestamp
```

Note this runs **every** root, including `always` roots already being driven by the RAF. In
a multi-root app, use `stepRoot` instead to avoid ticking those siblings twice.

### `stepRoot(rootId, timestamp?)`

Execute a single frame for one root, leaving its siblings untouched. This is the form to
use when a host drives a `never` root from its own loop while other roots stay on the
shared RAF driver:

```ts
scheduler.registerRoot('xr', { frameloop: 'never' })
renderer.xr.setAnimationLoop((time) => scheduler.stepRoot('xr', time))
```

Like `step()`, it runs global before/after jobs and does **not** consume a pending demand
frame. An unknown root warns and is otherwise ignored.

### `stepJob(id, timestamp?)`

Execute a single job by id, bypassing the normal order and FPS limiting. Handy for testing
one job in isolation.

```ts
scheduler.stepJob('my-physics-sim')
```

---

## Global jobs and idle callbacks

Lower-level hooks that run once per frame (not per-root). react-three-fiber's legacy
`addEffect` / `addAfterEffect` / `addTail` exports are thin wrappers over these.

### `registerGlobal(phase, id, callback)`

Run a callback once per frame, before or after all roots. Returns an unsubscribe function.

```ts
const unsub = scheduler.registerGlobal('before', 'my-global', (timestamp) => {
  // runs before all roots
})
```

These callbacks receive only the raw RAF timestamp — no root state. Prefer a normal job in
the `start` / `finish` phase when you need state or delta.

### `onIdle(callback)`

Register a callback fired when the loop stops in demand mode (pending frames reach 0).
Returns an unsubscribe function.

```ts
const unsub = scheduler.onIdle((timestamp) => {
  saveState()
})
```

---

## Testing with manual stepping

`frameloop='never'` plus `step()` makes frame logic fully deterministic:

```ts
import { Scheduler, getScheduler } from '@pmndrs/scheduler'

describe('animation system', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    Scheduler.reset() // fresh singleton
    scheduler = getScheduler()
    scheduler.frameloop = 'never' // drive frames manually; register() creates the root
  })

  afterEach(() => Scheduler.reset())

  it('integrates position over time', () => {
    let position = 0
    scheduler.register(
      (state, delta) => {
        position += delta * 10
      },
      { phase: 'physics' },
    )

    scheduler.step(0)
    scheduler.step(16.67) // ~60fps
    scheduler.step(33.34)

    expect(position).toBeGreaterThan(0)
  })
})
```

`Scheduler.reset()` stops the loop and clears the global singleton — call it between tests
for isolation.

---

## Performance notes

1. **Organize with phases**, not just priority numbers — intent stays clear.
2. **Throttle expensive jobs** with `fps` to protect the frame budget.
3. **Toggle with `enabled`** instead of early-returning inside a job that still runs.
4. **Avoid churn** — frequently changing `phase`/`before`/`after` forces re-sorts.
5. **Watch job count** in production via `getJobCount()`.

---

## Type definitions

```ts
type Frameloop = 'always' | 'demand' | 'never'

interface FrameTimingState {
  time: number // high-res RAF timestamp (ms)
  delta: number // seconds since last frame
  elapsed: number // seconds this root has been ticking (sleeping roots don't accrue)
  frame: number // incrementing counter
}

// Default callback state is timing-only. Pass T to type injected root state.
type FrameCallback<T = FrameTimingState> = (state: T & FrameTimingState, delta: number) => void

interface UseFrameOptions {
  id?: string
  phase?: string
  before?: string | string[]
  after?: string | string[]
  priority?: number
  fps?: number
  drop?: boolean
  enabled?: boolean
}

interface AddPhaseOptions {
  before?: string
  after?: string
}
```

The full public surface (`SchedulerApi`, `RootOptions`, `FrameControls`, etc.) is exported
from `@pmndrs/scheduler`.

---

## See also

- **[Concepts](./concepts.md)** — jobs, phases, the frame budget, and the design.
- **[useFrame Hook](./use-frame.md)** — the React binding.
