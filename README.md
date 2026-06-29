# @pmndrs/scheduler

A small, framework-agnostic frame scheduler with **phases**, **priorities**, and **per-job FPS throttling** — the engine behind [react-three-fiber](https://github.com/pmndrs/react-three-fiber)'s `useFrame`, extracted to run on its own.

- **One RAF loop** for your whole app, across multiple roots
- **Phases** (`start → input → physics → update → render → finish`) you can extend at runtime
- **Priorities** and cross-job `before`/`after` ordering (topological sort)
- **FPS throttling** per job, with drop or catch-up semantics
- **Demand** (`invalidate`) and **manual** (`step`) frame modes
- Zero dependencies. Vanilla core pulls in **no React**.

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

## License

MIT
