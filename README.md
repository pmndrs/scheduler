# @pmndrs/scheduler

A small, **standalone**, framework-agnostic frame scheduler with **phases**, **priorities**, and **per-job FPS throttling**. One RAF loop, any renderer, no framework required.

- **One RAF loop** for your whole app, across multiple roots
- **Phases** (`start → input → physics → update → render → finish`) you can extend at runtime
- **Priorities** and cross-job `before`/`after` ordering (topological sort)
- **FPS throttling** per job, with drop or catch-up semantics
- **Demand** (`invalidate`) and **manual** (`step`) frame modes
- Zero dependencies. Vanilla core pulls in **no React**.

## Status: standalone, port in progress

This is its own package, not a build artifact of another library. It began as the core
frame scheduler inside [react-three-fiber](https://github.com/pmndrs/react-three-fiber)
(the engine behind its `useFrame`) and is being **ported into an independent, framework-agnostic
library** with its own API, docs, tests, and release cycle. The r3f lineage is where it came
from — not something it depends on; the vanilla core ships zero dependencies and no React.

> Pre-1.0: the port is ongoing and the API is still settling, but the package is standalone
> and usable today. Expect refinements before 1.0.

## Install

```bash
npm install @pmndrs/scheduler
```

React is an optional peer dependency, only needed for the `/react` entry.

## Vanilla

```ts
import { getScheduler } from '@pmndrs/scheduler'

const scheduler = getScheduler()
scheduler.independent = true // run without a host renderer

scheduler.register(
  (state, delta) => {
    // called every frame: state = { time, delta, elapsed, frame }
  },
  { phase: 'update' },
)
```

## React

```tsx
import { useFrame } from '@pmndrs/scheduler/react'

function Spinner() {
  useFrame((state, delta) => {
    // runs every frame
  })
  return null
}
```

`useFrame` returns a controls object (`{ id, scheduler, step, stepAll, pause, resume, isPaused }`)
where `isPaused` is reactive.

## Entry points

| Import                    | Contents                                   |
| ------------------------- | ------------------------------------------ |
| `@pmndrs/scheduler`       | `Scheduler`, `getScheduler`, all types     |
| `@pmndrs/scheduler/react` | `useFrame` + re-exported scheduler + types |

## Core ideas

Every `register` / `useFrame` call creates a **job**. Jobs run in named **phases**
(`start → input → physics → update → render → finish`) that you can extend at runtime, with
**priorities** and `before`/`after` dependencies inside each phase. It's a DAG scheduler:
you declare ordering, it figures out the sequence — no priority-number guessing.

```ts
scheduler.addPhase('ai', { after: 'physics', before: 'update' })

scheduler.register(processInput, { phase: 'input' })
scheduler.register(() => world.step(1 / 60), { phase: 'physics', fps: 60, drop: false })
scheduler.register(updateAI, { phase: 'ai', fps: 20 })
scheduler.register(render, { phase: 'render' })
```

## Documentation

Three guides, roughly in reading order. **New here? Start with Concepts** — it explains the
mental model (jobs, phases, the frame budget) that the API references build on.

- **[Concepts](./docs/concepts.md)** — start here. Jobs, phases, the frame budget, FPS throttling, frameloop modes, and the design rationale (why named phases beat priority numbers), ending in a full game-loop example.
- **[useFrame Hook](./docs/use-frame.md)** — the React API: registration timing, options, controls, examples, and best practices.
- **[Scheduler API](./docs/scheduler.md)** — the full vanilla surface: roots, phases, job registration & control, frameloop, demand mode, manual stepping, and testing.

## Examples

Runnable demos live in [`examples/`](./examples) — a [vanilla](./examples/vanilla) app and a
[React](./examples/react) app. From either directory: `pnpm install && pnpm dev`.

## License

MIT
