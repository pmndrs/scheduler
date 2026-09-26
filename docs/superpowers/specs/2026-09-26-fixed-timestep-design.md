# Fixed-timestep phases design

## Scope

Give phases a clock. A phase with a `timestep` runs its jobs once per whole timestep banked
from the root's clock, as many times per frame as needed, each time with `delta` exactly
equal to the timestep. This is the "Fix Your Timestep" accumulator (Fiedler, 2004), the
standard engine answer to running a simulation at a rate the display refresh does not
divide evenly, and the shape of Unity's `FixedUpdate`, Godot's `_physics_process`, and
Bevy's `FixedUpdate` schedule.

The default `physics` phase is fixed at `1 / 60` out of the box. That is the common case
and the docs are built around it.

Out of scope: a timer-driven driver, worker bridges, and per-substep interpolation of the
injected host state. Those build on this and are tracked separately.

## Problem

`fps` is a **ceiling**. A throttled job can only run on a driver frame, so it runs on the
first frame at which its interval has elapsed, and at most once per frame. Its `delta` is
the real time since it last ran. Two consequences:

1. A rate that is not a whole fraction of the display rate is quantized. `fps: 24` on a
   60Hz display runs every third frame (20fps) with `drop: true`, or alternates two and
   three frames apart (33ms, 50ms) with `drop: false`.
2. A simulation that needs a constant `delta` for stability (rigid bodies, cloth, springs
   with stiff constants) cannot get one, and a slow frame cannot be caught up because the
   job cannot run twice.

The concepts guide used to describe `drop: false` as "good for physics". It is not. It
holds the average rate, nothing more.

## Why the clock belongs to the phase, not the job

An earlier draft put an accumulator on each job (`{ step: 1 / 60 }`). With two such jobs A
and B at the same rate, a slow frame ran A A A then B B B. Engines run substep 1 (A, B),
substep 2 (A, B), substep 3 (A, B): a controller that reads what the integrator wrote sees
every step. That interleaving needs one clock shared by a group of jobs, and the group this
scheduler already has is the phase. It also resolves where the interpolation fraction
lives: one clock per fixed phase means `state.overstep` has one value in the common case.

## Goals

- Jobs in a fixed phase receive exactly the phase's timestep as `delta` on every call.
- Time is conserved: over any span, `substeps × timestep` equals the time the root
  experienced, minus a remainder smaller than one timestep. No drift.
- Slow frames catch up by running the phase several times, bounded so a stall cannot
  spiral (each catch-up frame taking longer, falling further behind).
- Jobs in a fixed phase interleave per substep in job order.
- Every job in the root can read the fraction of a substep left over (`overstep`) to
  interpolate between the last two simulation states.
- It composes with what exists: root sleep caps (`maxDelta`), pause/resume, ambient
  adoption, manual stepping, demand roots, `updateJob`, and `useFrame` option updates.

## Non-goals

- Changing `fps` semantics. `fps` stays a ceiling for per-frame phases.
- Advancing `state.time` or `state.frame` per substep. They stay the driver's values.
- Running substeps in parallel with other phases. A fixed phase repeats as a unit in its
  slot in phase order.

## API

```ts
interface AddPhaseOptions {
  before?: string
  after?: string
  timestep?: number // seconds per substep; makes this a fixed phase
  maxSubsteps?: number // default 8
}

scheduler.addPhase('cloth', { after: 'physics', timestep: 1 / 30 })
scheduler.setPhaseTimestep(name, timestep | undefined, { maxSubsteps? }) // change, or per-frame again
scheduler.getPhaseTimestep(name) // number | undefined
scheduler.getOverstep(phase?, rootId?) // [0, 1); defaults: first fixed phase, first root

interface FrameTimingState {
  time: number // driver's, unchanged inside substeps
  frame: number // driver's, unchanged inside substeps
  delta: number // inside a fixed phase: exactly timestep
  elapsed: number // inside a fixed phase: substeps × timestep, advancing per substep
  overstep: number // [0, 1): fraction of the next substep banked; first fixed phase; 0 if none
}
```

Jobs need no new options: `{ phase: 'physics' }` is the opt-in. `JobOptions` is unchanged.

Naming: `timestep` rather than `step` because `scheduler.step()` is the manual tick;
`maxSubsteps` is Unity and Rapier vocabulary; `overstep` rather than Fiedler's `alpha`
because `alpha` means opacity in a renderer and r3f spreads this state onto its
`RootState`. Bevy exposes the same number as `overstep_fraction`.

## Semantics

The timestep is part of the phase definition and therefore global, like phase order. The
clock state (accumulator, substep count, pending substeps, overstep) is **per root**, keyed
by phase name, because roots own their own `delta` and `elapsed` and a sleeping demand root
must not accrue simulation time.

Per root tick, after the root's `delta` has been computed and capped, and before any job
runs:

```
for each fixed phase P:
    clock = root.clocks[P]
    clock.accumulator += delta
    pending = floor((clock.accumulator + EPSILON) / P.timestep)
    overflow = pending > P.maxSubsteps
    if overflow: pending = P.maxSubsteps
    clock.accumulator -= pending * P.timestep
    if overflow and clock.accumulator >= P.timestep:
        clock.accumulator %= P.timestep          // drop the surplus, keep the fraction
    clock.pending = pending
    clock.overstep = clock.accumulator / P.timestep
state.overstep = clocks[first fixed phase].overstep, or 0
```

Then phases run in order. A per-frame phase runs its jobs once, as today. A fixed phase
runs its whole bucket `pending` times, in job order, with one reused state object whose
`delta` is the timestep and whose `elapsed` is set to `clock.substeps × timestep` after
incrementing the count for each substep.

Advancing every clock up front, rather than when the phase is reached, means a job in
`start` and a job in `render` read the same `overstep` for the frame.

`EPSILON` is `1e-9` seconds. It exists only so that a driver whose frame interval equals
the timestep up to float rounding (a 60Hz display and `1 / 60`) fires exactly one substep
per frame rather than 0-2-1-1-0-2. It does not change how much time is subtracted, so it
cannot introduce drift; at worst the accumulator sits one billionth of a second negative.

### Overflow

Overflow means the root delivered more than `maxSubsteps × timestep` seconds in one tick.
The substep count is clamped and the surplus is **dropped**, keeping only the sub-step
fraction. Dropping is deliberate: carrying the debt forward is the spiral of death. The
simulation runs slow for one frame and then is back on the clock.

The default `maxSubsteps` of 8 tolerates a driver eight times slower than the substep rate
(`1 / 60` on a 7.5fps frame) before dropping time. Raise it for cheap steps, lower it to
protect the frame budget.

### `elapsed` inside a fixed phase

Every job today satisfies `elapsed == sum of the deltas it has received`. A fixed-phase job
is the first for which root time would break that: after a drop it has received less time
than the root experienced. Reporting `substeps × timestep` keeps the invariant. It is
computed as a product, not a running sum, so it is exact. The cost is that after a drop
(or a pause) the phase's clock sits permanently behind the root's by the dropped amount,
which is the truth: that time was not simulated. Wall-clock consumers read `state.time`.

### Interactions

| Concern                                       | Behavior                                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `maxDelta` (default: one driver frame)   | The clock receives the root's capped delta, so a demand root waking after a long sleep feeds at most one frame in. A root with `maxDelta: Infinity` after a tab hide relies on `maxSubsteps` instead. |
| First tick of a root                          | Root delta is 0, so 0 substeps.                                                                                                                                                                       |
| `pause()` / `enabled: false`                  | The clock is the phase's and keeps advancing; the job misses substeps and rejoins on the next. No burst on resume, nothing to reset.                                                                  |
| Ambient adoption                              | The ambient root's clocks migrate with its `lastTickTime` and `accumulatedTime`.                                                                                                                      |
| `stepJob(id)`                                 | One invocation with `delta = timestep` and the current simulated `elapsed`. The clock is untouched.                                                                                                   |
| `step()` / `stepRoot()`                       | Ordinary ticks; clocks advance and phases repeat as above.                                                                                                                                            |
| `setPhaseTimestep` to a different value       | Resets that phase's clock on every root (a smaller step would otherwise burst). Same value is a no-op.                                                                                                |
| `setPhaseTimestep(name, undefined)`           | The phase is per-frame again; its clock is dropped.                                                                                                                                                   |
| `resetTiming()`                               | Also clears every clock.                                                                                                                                                                              |
| Two roots, same fixed phase                   | Independent clocks and independent `overstep`.                                                                                                                                                        |
| Empty fixed phase                             | The clock still advances, so `overstep` stays meaningful.                                                                                                                                             |
| `fps` on a job in a fixed phase               | Warn (at `register` and on `updateJob` of `fps` or `phase`); the job runs every substep.                                                                                                              |
| `before: 'physics'` / `after: 'physics'`      | The auto-generated slot is a per-frame phase beside the fixed one, outside its clock.                                                                                                                 |
| Errors                                        | Each invocation is its own try/catch, routed to the root's `onError`; other jobs and remaining substeps still run.                                                                                    |
| Invalid `timestep` (≤ 0, NaN, Infinity)       | Warn; treated as unset.                                                                                                                                                                               |
| Invalid `maxSubsteps` (< 1, non-integer, NaN) | Warn; default 8.                                                                                                                                                                                      |

## Usage

```ts
scheduler.register(
  (state, dt) => {
    previous.copy(current)
    world.step(dt) // dt is exactly 1/60 every call
  },
  { phase: 'physics' },
)

scheduler.register((state) => mesh.position.lerpVectors(previous.position, current.position, state.overstep), {
  phase: 'render',
})

scheduler.setPhaseTimestep('physics', 1 / 120)
scheduler.addPhase('cloth', { after: 'physics', timestep: 1 / 30, maxSubsteps: 2 })
```

## Test plan

Every row is a deterministic test driven by `frameloop = 'never'` and explicit
timestamps, so the sequence of substep counts is exact and repeatable.

Defaults:

- [x] `physics` is fixed at `1 / 60`; the other default phases are per-frame.
- [x] A physics job receives `delta === 1 / 60` as both the argument and `state.delta`.
- [x] An `update` job still receives the root delta.

Exactness and conservation:

- [x] 60Hz driver: exactly one substep per frame (the EPSILON case).
- [x] 30Hz driver: exactly two substeps per frame.
- [x] `1 / 24` at 60Hz: 240 substeps over 10 s, ±1, never three skipped frames in a row.
- [x] 100k seeded-jitter frames: `substeps × timestep = elapsed − remainder`, remainder in
      `[0, timestep)`, `overstep` always in `[0, 1)`, last `state.elapsed` equals the
      simulated time.
- [x] One 100ms frame runs six substeps.
- [x] Identical timestamps produce identical per-frame counts.

Substep semantics:

- [x] Two jobs interleave per substep in job order (`A B, A B, A B`).
- [x] The phase repeats as a unit in its slot; `before:` / `after:` slots run once per frame.
- [x] `state.elapsed` advances per substep as `substeps × timestep`; the root's differs.
- [x] `state.time` and `state.frame` are the driver's inside substeps.
- [x] One state object is reused across a frame's substeps.
- [x] A throwing substep reaches `onError` and the remaining substeps still run.

Overflow:

- [x] A 1 s stall runs exactly 8 substeps and the next frame owes 1.
- [x] Custom `maxSubsteps` is honored.
- [x] The sub-step fraction survives overflow.

Overstep:

- [x] 16ms driver, 20ms timestep: 0.8 after frame one, 0.6 after frame two.
- [x] On state for every job in the root, computed before any job runs.
- [x] 0 with no fixed phase, for an unknown phase, and before the first tick.
- [x] `state.overstep` follows the first fixed phase; `getOverstep` reaches a second.
- [x] Independent per root.

Lifecycle:

- [x] `pause()` then `resume()` after a long gap: no burst.
- [x] The clock survives ambient adoption.
- [x] A waking demand root feeds in at most one capped frame.
- [x] A `maxDelta: Infinity` root after a long gap is bounded by `maxSubsteps`.
- [x] `stepJob` runs one substep with `delta = timestep` and the simulated `elapsed`.
- [x] `resetTiming()` clears the clocks.
- [x] An empty fixed phase still advances its clock.

Configuration:

- [x] `setPhaseTimestep` changes the rate and resets the clock; same value is a no-op;
      `undefined` returns to per-frame.
- [x] `addPhase` with `timestep` creates a second fixed phase.
- [x] Invalid `timestep` and `maxSubsteps` warn and fall back; unknown phase warns.
- [x] `fps` in a fixed phase warns at `register` and on `updateJob`, and the job runs every
      substep.
- [x] `useFrame`: a physics job gets the fixed delta and a render job reads `state.overstep`.

## Open questions

- A `state.substep` / `state.substeps` pair (index within the frame, count this frame)
  would let a fixed-phase job know when it is on the last substep of a frame, which is
  when some engines flush events. Deferred until a concrete need appears.
- Whether `physics` should stay fixed when a host (r3f) drives a `never` root from an XR
  loop at 90Hz. It does: the clock banks the 11ms deltas and runs 0-1-1 substeps. That is
  correct but worth a note in the host's docs.
