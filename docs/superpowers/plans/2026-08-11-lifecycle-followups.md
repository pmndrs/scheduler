# Lifecycle Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps found auditing the per-root frameloop branch, fix two pre-existing bugs the branch makes more reachable, and get react-three-fiber onto the per-root APIs so [issue #1](https://github.com/pmndrs/scheduler/issues/1) is actually resolved end-to-end.

**Architecture:** The per-root lifecycle model from `2026-08-10-per-root-frameloop-design.md` stands. This plan hardens its edges (driver ownership, manual stepping, introspection), makes timing coherent per root, and then extends the same "root owns its policy" idea to execution order.

**Tech Stack:** TypeScript 5.9, Vitest 4, jsdom, pnpm.

## Global Constraints

- Preserve the single application-wide `requestAnimationFrame` driver.
- Every phase must leave `pnpm ci` green.
- Additive API wherever possible; behavior changes go in release notes (see [Release sequencing](#release-sequencing)).
- Root-major execution (each root runs all its phases before the next root) stays the contract. Phase-major execution across roots is explicitly out of scope.
- Do not create a git commit unless the user explicitly requests one.

## Phases

| Phase | Content                                   | Blocks       |
| ----- | ----------------------------------------- | ------------ |
| 1     | Lifecycle hardening (Tasks 1–5)           | r3f adoption |
| 2     | Timing coherence (Tasks 6–7)              | —            |
| 3     | Pre-existing bug fixes (Tasks 8–9)        | Task 10      |
| 4     | Cross-root ordering (Task 10)             | —            |
| 5     | r3f adoption + issue filing (Tasks 11–12) | —            |

Phases 1–3 ship together as `0.2.0`; r3f adopts against that. Phase 4 ships as `0.3.0`.

## Decisions Taken

Recorded here so implementers don't re-litigate them mid-task.

1. **The bulk `frameloop` setter keeps its fan-out.** Tracking "which roots were explicitly set" replaces last-writer-wins with a subtler rule that is harder to explain. Instead it warns once when used with multiple roots, and `defaultFrameloop` becomes the honest name for the default-only behavior. Deprecating the setter waits until r3f is patched.
2. **Waking demand roots do not fast-forward.** A canvas that idles while off-screen and jumps on return is worse than one that resumes where it left off. The freeze policy is kept — but made deterministic and configurable via `maxDelta` rather than emerging from whether an unrelated sibling happens to be running.
3. **`stop()` becomes sticky, but explicit frame requests clear it.** `invalidate()`, `invalidateRoot()`, and `start()` clear the paused flag; root registration, mode changes, and the bulk setter do not. This matches pre-branch semantics, where only `invalidate` in demand mode could restart a stopped loop. _Alternative considered:_ paused blocks everything until `start()`. Rejected because it makes `invalidate()` a silent no-op after a `stop()`, which is its own debugging trap.
4. **Cross-root ordering starts as a numeric `order`, not a dependency graph.** Every hard semantic in the graph design (cycles, unresolved references, late registration, runtime updates) exists only because of the graph. An integer sorts async-mounted roots into place with no cycles possible. The graph is a later refinement if a concrete case demands it.

---

## Phase 1 — Lifecycle hardening

### Task 1: Stop the bulk setter from silently clobbering per-root modes

r3f writes `scheduler.frameloop` on every `configure()`, and `configure()` runs on every Canvas render. Under the branch's fan-out setter, each Canvas resets every sibling's mode continuously. Until r3f is patched (Task 11) this must at least be visible.

**Files:**

- Modify: `src/core/scheduler.ts`, `src/types.ts`
- Modify: `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Produces: `SchedulerApi.defaultFrameloop: Frameloop`

- [x] **Step 1:** Add a `warnedBulkFrameloop` private flag. In `set frameloop`, warn once when `this.roots.size > 1`:

```ts
console.warn(
  `[Scheduler] scheduler.frameloop applied to ${this.roots.size} roots. ` +
    `Use setRootFrameloop(rootId, mode) for per-root control.`,
)
```

Warn-once is required, not cosmetic — an unguarded warn floods the console once per React render.

- [x] **Step 2:** Add `defaultFrameloop` getter/setter that reads and writes `_frameloop` only, with no fan-out and no reconcile.
- [x] **Step 3:** Update the `frameloop` setter JSDoc to describe it as the legacy bulk control and point at `setRootFrameloop` / `defaultFrameloop`.
- [x] **Step 4:** Tests — warn fires once with two roots and never with one; `defaultFrameloop` leaves existing roots untouched but applies to roots registered afterwards.

### Task 2: Add `stepRoot` and generalize frame execution

`step()` runs every root. r3f's `advance()` is wired to it and driven from the XR animation loop, so with per-root `never` now viable an XR canvas next to an `always` canvas double-ticks the sibling every frame. Per-root `never` is not usable downstream without this.

**Files:**

- Modify: `src/core/scheduler.ts`, `src/types.ts`
- Modify: `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Produces: `SchedulerApi.stepRoot(rootId: string, timestamp?: number): void`

- [x] **Step 1:** Widen the execution selector rather than duplicating the frame body:

```ts
private executeFrame(timestamp: number, execution: 'all' | 'automatic' | RootEntry[] = 'all'): void {
  const frameRoots =
    execution === 'automatic' ? this.collectAutomaticRoots()
    : execution === 'all' ? Array.from(this.roots.values())
    : execution
  // ...unchanged
}
```

- [x] **Step 2:** Add `stepRoot(rootId, timestamp?)`. Warn and no-op on an unknown root, consistent with `setRootFrameloop` / `invalidateRoot`.
- [x] **Step 3:** Document two deliberate choices in the JSDoc: it **does** run global before/after jobs (consistent with `step()`, so `addEffect` users keep working when XR drives the frame), and it does **not** consume a pending demand frame (also consistent with `step()`).
- [x] **Step 4:** Tests — `stepRoot` ticks only the named root; an `always` sibling is not double-ticked; a `never` root is steppable; unknown root warns and no-ops.

### Task 3: Make `stop()` sticky

`stop()` cancels the RAF but leaves root modes untouched, so the next `reconcileLoop()` from any source re-derives "should run" and restarts. In r3f that is the next Canvas render.

**Files:**

- Modify: `src/core/scheduler.ts`
- Modify: `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`

- [x] **Step 1:** Add a `paused` flag:

```ts
private paused = false

start(): void { this.paused = false; this.forceRunning = true;  this.startLoop() }
stop():  void { this.paused = true;  this.forceRunning = false; this.stopLoop() }

private reconcileLoop(): void {
  if (this.paused) return
  if (this.forceRunning || this.hasAutomaticWork()) this.startLoop()
  else this.stopLoop()
}
```

- [x] **Step 2:** Clear `paused` in `invalidate()` and `invalidateRoot()` before reconciling (see Decision 3).
- [x] **Step 3:** Remove the early-return-before-reconcile in `setRootFrameloop`. Keep the changed-check only for clearing `pendingFrames`; always reconcile. With `paused` in place this can no longer resurrect a stopped driver.
- [x] **Step 4:** Document on `stop()` exactly what does and does not wake the loop.

> **Implementation note.** `unregisterRoot` called `this.stop()` for last-root teardown, which would have latched `paused` and left a later registration silently frozen. Teardown now uses `forceRunning = false; stopLoop()` directly — only a user-initiated `stop()` may pause. Pinned by `does not latch paused when the last root unregisters`.

- [x] **Step 5:** Tests — a root registering after `stop()` leaves the driver stopped; the bulk setter after `stop()` leaves it stopped; `invalidate()` and `start()` resume; `step()` and `stepRoot()` still work while paused; a same-mode `setRootFrameloop` recovers a stopped-but-not-paused driver.

### Task 4: ~~Grant one frame when a root enters demand~~ — REVERSED during implementation

**Original rationale:** switching `always` → `demand` leaves the surface showing the previous frame until something invalidates; v9's `setFrameloop` invalidated.

**Why it was dropped.** Implementing it broke three existing tests, all asserting that switching to `demand` quiesces the driver — a contract worth keeping. Two problems surfaced:

1. The stale-surface premise is wrong for the motivating case. A root going `always` → `demand` drew a _current_ frame one RAF ago. The genuinely stale case is `never` → `demand`, which is rarer and which a host can invalidate explicitly.
2. It creates an incoherence. Registering a root **as** `demand` grants zero frames (registration doesn't route through `applyRootFrameloop`), so granting one on the **transition** would make the two paths behave differently for no defensible reason.

**Resolved instead:** a uniform rule, documented on `applyRootFrameloop` and in `docs/scheduler.md` — a demand root draws only when invalidated, however it got into demand. Hosts needing a frame on the transition call `invalidateRoot` themselves.

- [x] **Step 1:** Keep `applyRootFrameloop` clearing pending frames on exit from demand and granting nothing on entry.
- [x] **Step 2:** Test — `sleeps immediately on entering demand, however the root got there`, covering both the switched and registered-as paths in one assertion.

### Task 5: Root and job introspection

There is no way to read a root's mode, and a hook-registered job cannot wake its own root. r3f holds its own `rootId`, but bare `@pmndrs/scheduler` consumers have no path at all.

**Files:**

- Modify: `src/core/scheduler.ts`, `src/hooks/useFrame.ts`, `src/types.ts`
- Modify: `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`, `tests/useFrame.test.tsx`

**Interfaces:**

- Produces: `SchedulerApi.getRootFrameloop(rootId: string): Frameloop | undefined`
- Produces: `SchedulerApi.getRootIds(): string[]`
- Produces: `FrameControls.rootId: string | undefined`
- Produces: `FrameControls.invalidate(frames?: number, stackFrames?: boolean): void`

- [x] **Step 1:** Add `getRootFrameloop` and `getRootIds`.
- [x] **Step 2:** Add a private `findRootIdForJob(jobId)` helper. Several methods already scan roots for a job id (`unregister`, `updateJob`, `stepJob`) — refactor them onto it.
- [x] **Step 3:** Resolve `FrameControls.rootId` **lazily at access time**, not at registration. Adoption moves jobs between roots, so a value captured at register time goes stale.
- [x] **Step 4:** `FrameControls.invalidate` targets the owning root via that lookup.
- [x] **Step 5:** Tests — `rootId` reflects the host after ambient adoption; `controls.invalidate()` wakes only the owning root.

> **Implementation note.** The helper landed as `private findRootForJob(jobId): RootEntry | undefined` (returning the entry, which is what the four existing call sites needed) plus a public `getJobRootId(jobId)` wrapping it, since the hook needs the id across the module boundary. `isJobPaused` was folded onto it as well. `getJobRootId` is an addition to the planned interface list.
>
> The `invalidate()` test drives the RAF path rather than `step()`: `step()` runs every root regardless of pending frames, so it cannot distinguish targeted from global invalidation and would pass either way.

---

## Phase 2 — Timing coherence

### Task 6: Per-root delta and elapsed

Timing is scheduler-wide, which only became observable once roots could sleep independently. Two problems: a waking demand root's delta is 0 or ~16ms depending on whether an unrelated sibling is running, and `elapsed` keeps advancing while a root sleeps — so freezing `delta` but not `elapsed` is internally inconsistent, and `state.elapsed` (the usual `uTime` source) jumps on wake anyway.

Separating _measurement_ from _policy_ fixes both with one mechanism. For an `always` root the result is bit-identical to today, since `timestamp - lastTickTime` **is** the driver delta.

**Files:**

- Modify: `src/core/scheduler.ts`, `src/types.ts`
- Modify: `docs/concepts.md`, `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Produces: `RootOptions.maxDelta?: number` (seconds; default is one driver frame — see the deviation note below)
- Produces: `RootEntry.lastTickTime: number | null`, `RootEntry.accumulatedTime: number`, `RootEntry.maxDelta: number | undefined`

- [x] **Step 1:** Compute timing per root in `tickRoot`:

```ts
const rawDelta = root.lastTickTime === null ? 0 : (timestamp - root.lastTickTime) / 1000
const delta = Math.min(rawDelta, root.maxDelta)
root.lastTickTime = timestamp
root.accumulatedTime += delta
// frameState: { time: timestamp, delta, elapsed: root.accumulatedTime, frame: this.loopState.frameCount }
```

- [x] **Step 2:** Keep the shared `loopState` update in `executeFrame` — `time` and `frame` stay driver-scoped. Only `delta` and `elapsed` become per-root.
- [x] **Step 3:** Reset `lastTickTime` to `null` on `registerRoot` and after ambient adoption, so a fresh root's first frame is `0` rather than a huge diff.
- [x] **Step 4:** Apply the same per-root computation in the `stepJob` path.
- [x] **Step 5:** Document the default in `docs/concepts.md`: sleeping roots do not accumulate time; a waking demand root receives at most `maxDelta`. Raising `maxDelta` restores v9-style catch-up; `Infinity` reproduces `THREE.Clock.getDelta()` exactly.
- [x] **Step 6:** Tests — an `always` root's deltas are unchanged from current behavior; a waking demand root gets the same delta whether or not a sibling is running; `elapsed` equals the sum of the deltas that root received; `maxDelta: Infinity` restores catch-up. Plus: a late-registered root starts at `elapsed` 0, and adoption carries the ambient clock across.

> **Deviation 1 — the default cap cannot be a constant.** The plan said `maxDelta` defaults to `1 / 60`, which is wrong: at 60Hz a real frame is often marginally _over_ 16.67ms, and on a 30Hz display every frame is 33ms. A constant default would clamp ordinary frames and halve animation speed on slower displays. The default is now **one driver frame** (`root.maxDelta ?? driverDelta`), which self-tunes to the refresh rate and is exactly the driver delta for any root that runs every frame — so the common path is provably unchanged. An explicit number still opts into bounded catch-up, `Infinity` into wall-clock.
>
> **Deviation 2 — `startLoop` no longer seeds `lastTime` from `performance.now()`.** Found by a failing test: after a full driver stop, the first frame's driver delta was measured between `performance.now()` at start and whatever timestamp the driver was fed. Those agree for RAF in a browser but not for injected timestamps, and the bogus interval became a bogus delta cap — a waking root teleported 8s in the test. `lastTime` now starts `null`, so the first frame after any (re)start reports a zero driver delta. This also makes the stopped-span exclusion exact instead of approximate.
>
> **Note on `stepJob`.** It reports a per-root delta but deliberately does **not** commit `lastTickTime` / `accumulatedTime`: stepping one job in isolation must not advance the root's frame clock and shrink the delta its next real frame receives. Its `elapsed` was also in milliseconds while `tickRoot`'s was in seconds; both are now seconds.

### Task 7: Pause compensation and frame-count caveat

**Files:**

- Modify: `src/core/scheduler.ts`, `src/types.ts`
- Modify: `docs/scheduler.md`, `docs/concepts.md`

- [x] **Step 1:** ~~Fix the sign~~ **Removed the machinery instead.** The plan called for fixing `createdAt - (performance.now() - stoppedTime)`, which subtracts the paused span where it should add it. But once Task 6 landed, `stepJob` — the only reader of `createdAt` — takes its elapsed from the root, leaving `createdAt` and `stoppedTime` written but never read. Fixing the sign of a value nothing observes would have produced untestable code, so both fields are gone from `FrameLoopState` and `startLoop`. Per-root accumulation excludes stopped spans by construction, which is what the compensation was approximating.
- [x] **Step 2:** Documented in `docs/concepts.md` that `frame` is a driver-scoped marker that resets when the RAF restarts, and shouldn't be used to derive state in demand-heavy apps. No code change, per your call that this is acceptable noise.
- [x] **Step 3 (added):** `resetTiming()` now also clears every root's `lastTickTime` and `accumulatedTime`. Without it the method no longer did what its name promises, since the timing it used to reset had moved onto the roots.

> **Left in place:** `loopState.elapsedTime` is still maintained but is no longer read by frame state. Kept as the driver's own running time — `resetTiming` documents it, and it is the natural surface for any future driver-level introspection. Flagged here so it isn't mistaken for an oversight.

---

## Phase 3 — Pre-existing bug fixes

Both of these exist on `main` and are independent of the lifecycle work. Task 9 must land before Task 10.

### Task 8: FPS-throttled jobs receive the wrong delta

`shouldRun` gates _whether_ a job runs, but `tickRoot` hands every job the same root delta. An `fps: 30` job in a 60fps root is invoked every ~33ms and told `delta ≈ 0.0167`, so anything doing `x += delta * speed` runs at half speed. The real interval is already tracked in `job.lastRun`.

**Files:**

- Modify: `src/core/rateLimiter.ts`, `src/core/scheduler.ts`, `src/types.ts`
- Test: `tests/scheduler.test.ts`

- [x] **Step 1:** ~~Record the interval in `shouldRun`~~ **Not needed.** `rateLimiter.ts` is untouched apart from `resetJobTiming`.
- [x] **Step 2:** Track `job.lastRunElapsed` — the owning root's `accumulatedTime` when the job last ran — and difference it. `resetJobTiming` clears it, so a resumed job isn't billed for the span it was paused.
- [x] **Step 3:** Tests — a throttled job gets the real interval between its runs; an unthrottled job in the same root is unchanged; a throttled job in a sleeping root doesn't teleport; a resumed job isn't charged for the pause.

> **Deviation — a simpler mechanism, because the planned one collided with Phase 2.** The plan said to clamp the job interval by `root.maxDelta`. That breaks the fix: `maxDelta` now defaults to _one driver frame_, which is smaller than any throttle period, so an `fps: 30` job would still be handed 16ms. Attempts to special-case the cap (one throttle period? two?) all needed an arbitrary constant, and none handled `fps: 45` in a 60Hz loop, where the job genuinely runs every 33ms rather than the 22ms it asked for.
>
> Differencing the root's `accumulatedTime` sidesteps all of it. The root's clock already excludes slept frames by construction, so the job inherits the sleep cap for free, needs no new constant, and reports the true interval whatever the throttle rate. It is also uniform: applied to every job, not just throttled ones, and for a job that runs every tick it equals the root delta exactly — so the common path is provably unchanged.
>
> **Consequence for `drop: false`.** Catch-up jobs now receive real elapsed time rather than the root delta. That is strictly more accurate than today, but it is _not_ a fixed timestep — a simulation wanting exactly `1/fps` per step must still clamp its own input. Called out in the release notes.

### Task 9: Unresolvable `before`/`after` targets pollute the global phase graph

`useFrame(fn, { after: 'main' })` with no explicit phase routes through `resolveConstraintPhase` → `ensureAutoPhase`, and because `main` is a job id rather than a phase, `getPhaseIndex` returns -1 and the new phase is **appended after `finish`**. The job runs dead last instead of where it asked, and since `phaseGraph` is one instance shared by every root, the junk `after:main` phase is permanent and global.

Verified: a job with `{ after: 'main' }` alongside `render` and `finish` jobs executes `['render', 'finish', 'wants-after-main']`, and `scheduler.phases.at(-1) === 'after:main'`.

**Files:**

- Modify: `src/core/phaseGraph.ts`, `src/core/scheduler.ts`
- Test: `tests/scheduler.test.ts`

- [x] **Step 1:** Three tiers, as planned.
- [x] **Step 2:** Landed as a private `Scheduler.resolveConstraintPhase` that mirrors `PhaseGraph`'s precedence (first `before`, else first `after`) and delegates to it for the phase tier. `PhaseGraph` stays free of job knowledge.
- [x] **Step 3:** Tests — a job-id target lands in the target's phase and sorts after it with no phantom phase; an unknown target warns and defaults to `update`; the phase tier still auto-generates as before.

> **Note.** The job-id lookup searches every root, so a cross-root reference now at least lands in a sensible phase instead of after `finish` — but it still cannot order across roots. That is Task 10's job, and the docs say so.

---

## Phase 4 — Cross-root ordering

### Task 10: Deterministic root execution order

Roots execute in Map registration order, and a job's `after` referencing a job in another root is dropped by the sorter. It looks correct only because the primary canvas usually registers first; Suspense, conditional rendering, remounting, or hydration can reverse it. Verified: reversing two roots' registration order reverses their render order despite `after: 'main'`.

**Files:**

- Modify: `src/core/scheduler.ts`, `src/types.ts`
- Modify: `docs/scheduler.md`, `docs/concepts.md`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Produces: `RootOptions.order?: number` (default `0`)
- Produces: `SchedulerApi.setRootOrder(rootId: string, order: number): void`

- [x] **Step 1:** `order` on `RootOptions` / `RootEntry`, default `0`, ties broken by a new `sequence` field (a dedicated counter — `nextRootIndex` belongs to `generateRootId` and only increments when that is called, so it would have produced gaps and mis-ordered explicitly-named roots).
- [x] **Step 2:** Cached `sortedRoots` + `rootsNeedSort`, rebuilt lazily on register, unregister, or order change.
- [x] **Step 3:** Both execution paths iterate it. The cache is _replaced_ rather than mutated on re-sort, so a frame that registers a root mid-flight keeps iterating its own snapshot — the existing `roots.get(root.id) !== root` guard still covers removals.
- [x] **Step 4:** `setRootOrder(rootId, order)`; warns and no-ops on unknown roots.
- [x] **Step 5:** Documented in `docs/scheduler.md` and `docs/concepts.md`.
- [x] **Step 6:** Tests — reversed registration, equal-order fallback, runtime reorder with a sleeping root in between, ordering preserved after an unregister, and `step()` following the same order.

> **Also changed:** `getRootIds()` now returns execution order rather than Map order. With no explicit ordering the two are identical, so nothing observable changes for existing callers, and "the order they run in" is the more useful answer when debugging why one canvas drew first.

**Deferred:** root-level `before`/`after` constraints. If a concrete case needs them, extract the Kahn implementation in `sorter.ts:100` to a generic over `{ id, before, after, index }` and reuse it — including its cycle fallback (warn once, append unresolved members in registration order). Unlike jobs, an unresolved _root_ reference should **persist** rather than be dropped at sort time, because async mounting makes late arrival normal.

---

## Phase 5 — Downstream

### Task 11: react-three-fiber adoption

Tracked in `2026-08-11-r3f-adoption-issue.md`, to be filed against `pmndrs/react-three-fiber`. Requires `@pmndrs/scheduler@^0.2.0`.

- [ ] Pass `frameloop` into `registerRoot` options (renderer.tsx:638)
- [ ] `setRootFrameloop(rootId, frameloop)` instead of the global write (renderer.tsx:771)
- [ ] Same swap in `setFrameloop` (store.ts:213)
- [ ] Root-scoped `invalidateRoot` for `state.invalidate` (store.ts:106, 181, 200)
- [ ] Keep the exported `invalidate()` as global fan-out (legacy.ts:121) — drei calls it stateless
- [ ] `advance()` / XR `handleXRFrame` → `stepRoot` (legacy.ts:137, renderer.tsx:514)

### Task 12: Issue hygiene

- [ ] File the r3f issue from `2026-08-11-r3f-adoption-issue.md`
- [ ] Comment on [scheduler#1](https://github.com/pmndrs/scheduler/issues/1) stating precisely what the branch does and does not fix, and that the symptom persists until the r3f patch lands
- [ ] Open follow-up issues for Phase 4 and for the deferred root-level `before`/`after`
- [ ] Delete `2026-08-11-r3f-adoption-issue.md` once filed

---

## Release sequencing

**`0.2.0`** — Phases 1–3.

Additive: `stepRoot`, `getRootFrameloop`, `getRootIds`, `defaultFrameloop`, `RootOptions.maxDelta`, `FrameControls.rootId` / `.invalidate`.

Behavior changes for release notes:

- `stop()` is sticky; only `start()` and explicit invalidation resume the driver.
- Entering `demand` grants one frame.
- `elapsed` is per-root accumulated time, not driver wall-clock. Visible to demand roots only.
- Throttled jobs receive their real interval as `delta`, not the root delta. Anything compensating manually for the old half-speed behavior will now double-count.
- The bulk `frameloop` setter warns with multiple roots.

**`0.3.0`** — Phase 4. Additive (`RootOptions.order`, `setRootOrder`); execution order is unchanged for roots that set no order.

r3f bumps to `^0.2.0` in Task 11 and does not need `0.3.0`.

## Verification

Run `pnpm ci` after every task. Each task's tests must fail before its implementation and pass after.
