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
scheduler.independent = true // run without a host renderer

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

> **Roots.** Jobs live under a **root**. In react-three-fiber each `<Canvas>` registers a
> root for you. Standalone, you either flip `scheduler.independent = true` (creates a
> default root) or call `scheduler.registerRoot(id)` yourself. See the
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

## Frameloop modes

Control how the loop runs via `scheduler.frameloop`:

```ts
scheduler.frameloop = 'always' // continuous RAF (default)
scheduler.frameloop = 'demand' // only render when invalidate() is called
scheduler.frameloop = 'never' //  manual — advance with step()
```

- **`always`** — jobs run every animation frame.
- **`demand`** — the loop sleeps until `scheduler.invalidate()` requests frames. Great for
  static scenes that change occasionally.
- **`never`** — nothing runs until you call `scheduler.step()`. Great for tests and
  non-realtime rendering.

```ts
// demand
scheduler.frameloop = 'demand'
button.addEventListener('click', () => {
  updateSomething()
  scheduler.invalidate() // request one frame
})

// never
scheduler.frameloop = 'never'
scheduler.step() // advance exactly one frame
```

> In react-three-fiber the `<Canvas frameloop="...">` prop sets this for you.

## A real game loop

Putting it together (vanilla):

```ts
const scheduler = getScheduler()
scheduler.independent = true

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
