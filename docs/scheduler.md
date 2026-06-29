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
- Demand mode via `invalidate()`

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

## Independent mode

Run the scheduler without any host (no Canvas, no renderer).

### `independent` (getter/setter)

```ts
getScheduler().independent = true
```

- When set to `true`, a default root is created automatically.
- Callbacks receive timing-only [`FrameTimingState`](#type-definitions): `{ time, delta, elapsed, frame }`.
- Useful for game loops, animations, or any frame-based logic with no renderer.

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
standalone you create one via `independent = true` or `registerRoot`.

### `registerRoot(id, options?)`

Register a root. The first root to register starts the loop (when `frameloop='always'`).
Returns an unsubscribe function.

```ts
interface RootOptions {
  getState?: () => any // state provider merged into the frame state
  onError?: (error: Error) => void // job error handler (default: console.error)
}
```

```ts
// With injected state — callbacks receive getState() merged with timing
const unsubscribe = scheduler.registerRoot('my-root', {
  getState: () => store.getState(),
  onError: (err) => reportError(err),
})

// Minimal — timing-only state
scheduler.registerRoot('standalone')
```

- `getState` is how a host injects its own state (r3f injects its `RootState`). Whatever it
  returns is spread into the object passed to every job callback, alongside timing.
- The last root to unregister stops the loop.

### `unregisterRoot(id)`

```ts
scheduler.unregisterRoot('my-root')
```

### `generateRootId(): string`

Returns a unique id like `'root_0'`.

### `getRootCount(): number`

Number of registered roots.

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

Start or stop the RAF loop. `start()` is a no-op if already running and is called
automatically when the first root registers (under `frameloop='always'`); `stop()` is
called automatically when the last root unregisters.

```ts
scheduler.start()
scheduler.stop()
```

### `isRunning` (getter): `boolean`

### `frameloop` (getter/setter)

`'always' | 'demand' | 'never'`

```ts
scheduler.frameloop = 'demand'
```

- `'always'` — continuous (default).
- `'demand'` — render only when `invalidate()` is called.
- `'never'` — manual; advance with `step()`.

Switching to `'always'` starts the loop; switching away from it stops the loop.

### `invalidate(frames?, stackFrames?)`

Request frames in demand mode. Accumulates pending frames (capped at 60) and starts the
loop if needed. No-op unless `frameloop === 'demand'`.

```ts
scheduler.invalidate() // one frame
scheduler.invalidate(5) // five frames
scheduler.invalidate(3, false) // set pending to exactly 3
scheduler.invalidate(2, true) // add 2 to the pending count
```

Each executed frame decrements the pending count; when it hits 0 the loop stops and
[`onIdle`](#onidlecallback) callbacks fire.

### `resetTiming()`

Reset `lastTime`, `frameCount`, and `elapsedTime` without touching jobs or roots. Mostly
for deterministic tests.

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
    scheduler.independent = true
    scheduler.frameloop = 'never'
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
  elapsed: number // seconds since first frame
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
