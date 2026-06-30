# useFrame Hook

`useFrame` is the React binding for `@pmndrs/scheduler`. It registers a callback that runs
every frame and returns controls for stepping, pausing, and resuming the job.

```tsx
import { useFrame } from '@pmndrs/scheduler/react'
```

> react-three-fiber ships its **own** `useFrame` built on this same scheduler, where the
> callback receives r3f's `RootState` (`renderer`, `scene`, `camera`, …) and is
> _host-guaranteed_ — outside a `<Canvas>` it waits for one. The standalone
> `@pmndrs/scheduler/react` hook documented here has no host requirement: it runs immediately
> with **timing-only** state unless a root injects its own — see [Frame state](#frame-state).

## Basic usage

```tsx
import { useRef } from 'react'
import { useFrame } from '@pmndrs/scheduler/react'

function Spinner() {
  const ref = useRef<HTMLDivElement>(null)

  useFrame((state, delta) => {
    if (ref.current) ref.current.style.transform = `rotate(${state.elapsed * 90}deg)`
  })

  return <div ref={ref} className="box" />
}
```

## Registration timing

Registration is **immediate and needs no setup** — `useFrame` always has a root to attach
to. There are two situations:

### A host is present (e.g. react-three-fiber)

When a host has registered a root, the job registers against it and receives that host's
injected state merged with timing.

### No host (standalone), or a host that mounts later

With no host, the job attaches to the scheduler's lazily-created **ambient root** and fires
with timing-only state. No flag or startup call is required:

```tsx
function GameLoop() {
  useFrame((state, delta) => {
    updateGame(delta) // state = { time, delta, elapsed, frame }
  })
  return null
}
```

If a host registers _later_, it **adopts** the already-registered job, which then begins
receiving the host's state on the next frame — no waiting or coordination; ordering is handled
for you. That's the behavior of this standalone hook.

> react-three-fiber's own `useFrame` builds on the same adoption mechanism but additionally
> **holds the callback until a host is present**, so its callbacks always receive full
> `RootState` (never timing-only frames). Outside a `<Canvas>` it effectively waits; for
> hostless loops you use this `@pmndrs/scheduler` hook instead.

See [Ambient root & host adoption](./design/ambient-root.md).

### Scheduler access only

Call `useFrame()` with no callback to grab the scheduler from anywhere — no job is
registered:

```tsx
function StopButton() {
  const { scheduler } = useFrame()
  return <button onClick={() => (scheduler.frameloop = 'never')}>Stop</button>
}
```

## API

```tsx
const controls = useFrame(callback?, priorityOrOptions?)
```

| Parameter           | Type                        | Description                                                  |
| ------------------- | --------------------------- | ------------------------------------------------------------ |
| `callback`          | `(state, delta) => void`    | Runs each frame. Optional if you only need scheduler access. |
| `priorityOrOptions` | `number \| UseFrameOptions` | A priority number (shorthand for `{ priority }`) or options. |

The hook is generic: `useFrame<T>(cb)` types the injected state as `T & FrameTimingState`.

### Frame state

The callback receives `(state, delta)`:

```ts
interface FrameTimingState {
  time: number // high-resolution RAF timestamp (ms)
  delta: number // seconds since last frame
  elapsed: number // seconds since first frame
  frame: number // incrementing frame counter
}
```

`delta` (seconds) is passed as the second argument for convenience — it's the same value as
`state.delta`. When a host injects state (react-three-fiber's `RootState`, or your own root
`getState`), those properties are merged onto `state` too.

### Options

```ts
interface UseFrameOptions {
  id?: string // unique id (auto-generated via useId if omitted)
  phase?: string // phase to run in (default: 'update')
  before?: string | string[] // run before this phase or job id
  after?: string | string[] // run after this phase or job id
  priority?: number // priority within a phase (higher first, default: 0)
  fps?: number // throttle to this rate
  drop?: boolean // drop missed frames (default: true) vs catch up
  enabled?: boolean // enable/disable without unregistering (default: true)
}
```

| Option     | Default    | Notes                                                                              |
| ---------- | ---------- | ---------------------------------------------------------------------------------- |
| `id`       | auto       | Stable id; auto-generated with React's `useId()`.                                  |
| `phase`    | `'update'` | One of `start`, `input`, `physics`, `update`, `render`, `finish`, or a custom one. |
| `before`   | –          | Run before a phase or job id. Auto-generates an ordering slot if needed.           |
| `after`    | –          | Run after a phase or job id.                                                       |
| `priority` | `0`        | Tie-break within a phase; higher runs first.                                       |
| `fps`      | –          | Throttle. No limit if unset.                                                       |
| `drop`     | `true`     | `true` drops missed frames; `false` catches up (good for simulations).             |
| `enabled`  | `true`     | When `false`, the job stays registered but the scheduler skips it.                 |

### Return value: controls

```ts
interface FrameControls {
  id: string // the job's id
  scheduler: Scheduler // the global scheduler
  step(timestamp?: number): void // step this job only (bypasses FPS limiting)
  stepAll(timestamp?: number): void // step ALL jobs once
  pause(): void // pause this job
  resume(): void // resume this job
  isPaused: boolean // reactive — re-renders on pause/resume
}
```

## Examples

### Phase-based ordering

```tsx
useFrame(() => world.step(1 / 60), { phase: 'physics' })
useFrame(updateGameLogic, { phase: 'update' })
useFrame(collectStats, { phase: 'finish' })
```

### Priority shorthand (backwards compatible)

A numeric second argument maps to `{ priority }`:

```tsx
useFrame(runsFirst, 10)
useFrame(runsSecond, 0)
```

### FPS throttling

```tsx
useFrame(expensiveWork, { fps: 30 }) // drop missed frames
useFrame(stepSimulation, { fps: 60, drop: false }) // catch up
```

### Pause and resume

```tsx
function Pausable() {
  const controls = useFrame(
    (state, delta) => {
      /* animation */
    },
    { id: 'my-animation' },
  )

  return (
    <button onClick={() => (controls.isPaused ? controls.resume() : controls.pause())}>
      {controls.isPaused ? 'Resume' : 'Pause'}
    </button>
  )
}
```

### Manual stepping (`frameloop='never'`)

```tsx
function StepButton() {
  const { stepAll } = useFrame((state, delta) => {
    /* only runs on stepAll() */
  })
  return <button onClick={() => stepAll()}>Step frame</button>
}
```

### Custom phases

```tsx
import { useEffect } from 'react'

function GameLoop() {
  const { scheduler } = useFrame()

  useEffect(() => {
    scheduler.addPhase('ai', { after: 'physics', before: 'update' })
  }, [scheduler])

  useFrame(aiUpdate, { phase: 'ai' })
  return null
}
```

### before / after constraints

```tsx
useFrame(updateTransforms, { id: 'transforms' })
useFrame(updateEffects, { after: 'transforms' }) // runs after
useFrame(handleInput, { before: 'transforms' }) // runs before
```

Dependencies can be plural: `{ after: ['physics', 'input'] }`.

### Conditional execution with `enabled`

Prefer `enabled` over early-returning inside a job that still runs every frame:

```tsx
// ❌ runs every frame just to bail
useFrame((state, delta) => {
  if (!isActive) return
  doWork(delta)
})

// ✅ the scheduler skips it entirely
useFrame((state, delta) => doWork(delta), { enabled: isActive })
```

### Reactive paused state

`isPaused` is backed by `useSyncExternalStore`, so it re-renders the component when the job
is paused or resumed — from anywhere, including `scheduler.pauseJob(id)`:

```tsx
function Status() {
  const controls = useFrame(animate, { id: 'fx' })
  return <div>Status: {controls.isPaused ? 'Paused' : 'Running'}</div>
}
```

## Best practices

1. **Order with phases**, not priority numbers — the intent reads clearly.
2. **Throttle heavy work** with `fps` instead of running it every frame.
3. **Toggle with `enabled`**, not early returns.
4. **Name jobs with `id`** for easier debugging and cross-component control.
5. **Avoid option churn** — changing options re-registers; use `enabled` to toggle.
6. **Pick `drop` deliberately** — `true` for visuals, `false` for simulations.
7. **Reach for `controls.scheduler`** when you need frame-loop-wide control.

## See also

- **[Concepts](./concepts.md)** — the design: jobs, phases, frame budget.
- **[Scheduler API](./scheduler.md)** — everything the hook is built on.
