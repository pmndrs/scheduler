# Concepts: Jobs, Phases, and the Frame Budget

`@pmndrs/scheduler` is a small DAG (directed acyclic graph) scheduler for frame-based
work. You register **jobs**; the scheduler runs them in the right order, every frame,
from a single `requestAnimationFrame` loop. It powers
[react-three-fiber](https://github.com/pmndrs/react-three-fiber)'s `useFrame`, but it has
no dependency on React or Three.js — it's just as happy driving a vanilla game loop, a
canvas 2D animation, or a simulation.

> For 90% of use cases you only need `useFrame((state, delta) => { ... })` (React) or
> `scheduler.register((state, delta) => { ... })` (vanilla). The rest of this page is for
> when you need real control.

## The frame budget

Any animation or render system shares one loop for everything — input, simulation,
rendering, post-processing. With 60fps as the baseline you get roughly **16.7ms of work
window** per frame to produce the next image, ideally well before the window closes.

At the start of every frame you "start working" and are handed timing for the frame: the
time since the previous frame started (the `delta`, hopefully ~16.7ms), the total elapsed
time, and a frame counter. Because that window is small — and the back half of it is
usually reserved for the actual draw — you have to plan the work you do. That window is
your **frame budget**, and the scheduler exists to help you spend it deliberately.

```
  one frame @ 60 fps  ≈  16.7 ms
  ┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
  │  start  │  input  │ physics │ update  │ render  │ finish  │
  └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
  0 ms ──────────── jobs run in phase order ──────────► 16.7 ms
                                  └─ the draw lands here, before
                                     the window closes
```

## Jobs and phases

Every `register` (vanilla) or `useFrame` (React) call creates a **job**. Each frame the
scheduler runs one RAF loop with a high-resolution timestamp and executes jobs in order.

Jobs are organized into **phases** — named stages that run in sequence:

```
Frame Budget (~16.7ms)
├─ start phase    - Early setup, frame initialization
├─ input phase    - Input processing, event handling
├─ physics phase  - Physics simulation
├─ update phase   - Game logic, animations (default)
├─ render phase   - Custom rendering, effects
└─ finish phase   - Cleanup, stats, telemetry
```

This is a **DAG scheduler**: jobs declare their phase and their dependencies, and the
scheduler computes the execution order. No more guessing with priority numbers.

```ts
import { getScheduler } from '@pmndrs/scheduler'

const scheduler = getScheduler()

// Input handling runs first
scheduler.register(processInput, { phase: 'input' })

// Physics after input
scheduler.register(() => world.step(1 / 60), { phase: 'physics' })

// Game logic after physics (default phase)
scheduler.register(updateGameState, { phase: 'update' })

// Cleanup and stats run last
scheduler.register(recordStats, { phase: 'finish' })
```

The same thing in React:

```tsx
import { useFrame } from '@pmndrs/scheduler/react'

useFrame(processInput, { phase: 'input' })
useFrame(() => world.step(1 / 60), { phase: 'physics' })
useFrame(updateGameState, { phase: 'update' })
useFrame(recordStats, { phase: 'finish' })
```

> **Roots.** Jobs live under a **root**. Standalone you don't manage this: the first
> `register` (or `useFrame`) lazily creates an ambient root. In react-three-fiber each
> `<Canvas>` registers its own root and **adopts** any jobs already registered. You can also
> call `scheduler.registerRoot(id)` yourself for explicit multi-root setups. See the
> [Scheduler reference](./scheduler.md#root-management).

## What this fixes

### 1. Priority numbers → named phases & dependencies

Priority numbers don't compose across libraries — if a library you don't control
registers at priority `0` and so do you, who runs first?

```ts
// Named phases — intent is explicit
scheduler.register(physicsStep, { phase: 'physics' })
scheduler.register(controllerUpdate, { phase: 'update' })

// Or explicit job dependencies
scheduler.register(cameraMove, { id: 'camera' })
scheduler.register(followCamera, { after: 'camera' })
```

### 2. Manual throttling → built-in FPS limiting

No more hand-rolled frame-timing checks in every job. Throttle per job and spread
expensive work across the budget:

```ts
scheduler.register(expensiveAI, { fps: 30 })
scheduler.register(heavyPhysics, { fps: 60 })
scheduler.register(particleUpdate, { fps: 20 })
```

### 3. State checks → job controls

Instead of checking a `paused` flag every frame (which still costs budget), control jobs
directly or disable them so the scheduler skips them entirely:

```ts
const handle = scheduler.register(doWork, { id: 'animation' })

scheduler.pauseJob('animation') // stops running, stays registered
scheduler.resumeJob('animation')

// Or never run at all while a condition is false
scheduler.updateJob('animation', { enabled: false })
```

In React, `useFrame` returns the same controls reactively — see
[`isPaused`](./use-frame.md#reactive-paused-state).

## Core concepts in practice

### Default phase: update

Most work goes in `update` by default:

```ts
scheduler.register(() => {
  /* runs in 'update' */
})

// Explicit — identical
scheduler.register(() => {}, { phase: 'update' })
```

### Custom phases

When the default phases aren't enough, insert your own relative to existing ones:

```ts
// Add an 'ai' phase between physics and update
scheduler.addPhase('ai', { after: 'physics', before: 'update' })

scheduler.register(aiSystemUpdate, { phase: 'ai' })
```

### `before` / `after`: implicit phases

Don't want to name a phase? Use `before`/`after` to create implicit ordering. The
scheduler auto-generates the necessary ordering slots (`before:render`, `after:render`):

```ts
scheduler.register(prepRenderTargets, { before: 'render' })
scheduler.register(copyToHUD, { after: 'render' })
```

This keeps any existing job in `render` intact — your work happens around it, not instead
of it. In react-three-fiber this is exactly how you compose around the default renderer.

### Job dependencies

Every job has a unique ID (auto-generated if you don't pass one). Reference IDs to create
hard ordering dependencies:

```ts
scheduler.register(updateCamera, { id: 'camera' })
scheduler.register(updateCharacter, { after: 'camera', id: 'character' })
scheduler.register(updateEnemies, { after: 'character' })
```

Dependencies can be plural:

```ts
scheduler.register(updateCharacter, { after: ['physics', 'input'] })
scheduler.register(earlySetup, { before: ['physics', 'update'] })
```

A `before`/`after` target can name either a phase or a job, and when you don't pass an
explicit `phase` the scheduler resolves it in that order:

1. **A phase** — it generates the ordering slot around it (`before:render`).
2. **A job id** — the job joins that job's phase, and the two are ordered within it.
3. **Neither** — it warns and falls back to `update`.

Tier 3 matters if you reference a job that hasn't registered yet, or one in a **different
root**: job dependencies only resolve within a single root. Order whole roots with
[root constraints](./scheduler.md#setrootconstraintsrootid-constraints) instead.

## FPS throttling and frame budget management

Not all work needs 60fps. Expensive operations can run slower without hurting perceived
quality:

```ts
scheduler.register(expensiveAI, { fps: 30 })
scheduler.register(particlePhysics, { fps: 40 })
scheduler.register(smoothAnimation) // every frame
```

### Drop vs catch-up

When a throttled job misses its window, you choose how it recovers:

- **Drop (`drop: true`, default)** — skip the missed frames. Good for visual/UI updates.
  ```ts
  scheduler.register(updateUI, { fps: 30, drop: true })
  ```
- **Catch-up (`drop: false`)** — advance timing to make up missed steps. Good for physics
  and simulations that need consistent timing.
  ```ts
  scheduler.register(physicsStep, { fps: 60, drop: false })
  ```

On high-refresh displays (120Hz, 144Hz) your every-frame work runs faster while throttled
jobs stay capped.

### Throttled jobs get their own delta

A throttled job receives the time since **its** last run, not since the last frame. An
`fps: 30` job in a 60fps loop is handed ~33ms, so `x += delta * speed` moves at the same
speed whether or not you throttle it:

```ts
// Both cross the screen at the same rate; one just updates half as often.
scheduler.register((state, delta) => (x += delta * 100))
scheduler.register((state, delta) => (y += delta * 100), { fps: 30 })
```

The delta is measured against the owning root's clock, so it also excludes any time the
root spent asleep — a throttled job in a demand canvas can't jump on wake either.

## Root ordering

Roots execute as complete units: one root runs all of its phases before the next root
starts. When canvases share a renderer, make that order explicit instead of relying on
which React tree mounts first:

```ts
scheduler.registerRoot('overlay', { after: 'main' })
scheduler.registerRoot('main')
```

`before` and `after` reference root ids and are hard dependencies. The optional numeric
`order` prioritizes roots that are currently free to run:

```ts
scheduler.registerRoot('background', { order: -10 })
scheduler.registerRoot('main', { after: 'background' })
```

The dependency graph is rebuilt only when roots or their constraints change, then cached
for frame execution. A sleeping root is filtered from that order without being woken.

## Frameloop modes

The scheduler owns one RAF driver, while each root owns its wake policy:

- **`always`** — that root runs every animation frame.
- **`demand`** — that root sleeps until it is invalidated.
- **`never`** — that root runs only during an explicit manual step.

```ts
scheduler.registerRoot('hero', { frameloop: 'demand' })
scheduler.registerRoot('game', { frameloop: 'always' })

scheduler.invalidateRoot('hero') // wakes only the hero
```

The RAF remains active while any root is `always` or any demand root has pending frames.
Sleeping roots are skipped entirely, including their state provider and jobs.

For single-root and legacy usage, `scheduler.frameloop` remains a bulk control. Its setter
updates every existing root and becomes the default for roots registered later:

```ts
scheduler.frameloop = 'demand'
button.addEventListener('click', () => {
  updateSomething()
  scheduler.invalidate() // wakes every demand root
})

scheduler.frameloop = 'never'
scheduler.step() // manually advances every root once
```

`start()` and `stop()` are low-level overrides. An explicit `start()` runs every root
continuously until `stop()` is called, and `stop()` holds the driver stopped — root
registration and mode changes won't restart it, only `start()` or an invalidation.

## Timing

`time` and `frame` come from the driver: every root running on the same animation frame
sees the same values.

`delta` and `elapsed` belong to the **root**. A root that sleeps doesn't accumulate time it
never saw, so `elapsed` is always the sum of the deltas that root actually received — not
how long the app has been running. A canvas that mounts ten seconds in starts at zero.

For a root that runs every frame — the common case — `delta` is exactly the driver's frame
delta, unchanged. The difference only shows up when a root skips frames:

```ts
// Off-screen for 8 seconds, then invalidated.
scheduler.invalidateRoot('hero')
// delta is ~0.016, not 8. The animation resumes; it doesn't jump forward.
```

That cap defaults to one driver frame, which self-tunes across refresh rates. Raise it per
root to allow bounded catch-up, or opt into true wall-clock deltas:

```ts
scheduler.registerRoot('sim', { frameloop: 'demand', maxDelta: 0.1 }) // catch up, bounded
scheduler.registerRoot('clock', { frameloop: 'demand', maxDelta: Infinity }) // wall clock
```

Pick `Infinity` when a root models real elapsed time (a simulation that must stay in sync
with the wall clock) and the default when it drives animation, where a jump reads as a
glitch.

> `frame` counts driver frames and resets whenever the RAF restarts, so it is a frame
> _marker_, not a stable per-root counter. In demand-heavy apps that start and stop the
> driver often, don't derive state from it.

## A real game loop

Putting it together (vanilla):

```ts
const scheduler = getScheduler()

// Custom AI phase between physics and update
scheduler.addPhase('ai', { after: 'physics', before: 'update' })

scheduler.register(processInput, { phase: 'input', id: 'input-handler' })

// Physics at 60fps, catching up if behind
scheduler.register(() => physicsWorld.step(1 / 60), { phase: 'physics', fps: 60, drop: false })

// AI at 20fps, dropping if behind
scheduler.register(aiSystemUpdate, { phase: 'ai', fps: 20, drop: true })

// Game state every frame
scheduler.register(updateGameState, { phase: 'update', id: 'game-state' })

// VFX depend on game state
scheduler.register(updateVFX, { after: 'game-state' })

// Stats at the very end
scheduler.register(collectStats, { phase: 'finish' })
```

## Where to next

- **[useFrame Hook](./use-frame.md)** — the React API, options, controls, best practices.
- **[Scheduler API](./scheduler.md)** — the full vanilla surface: roots, phases, job
  control, frameloop, demand mode, manual stepping, and testing.
