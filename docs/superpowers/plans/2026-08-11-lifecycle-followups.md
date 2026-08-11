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

- Produces: `RootOptions.maxDelta?: number` (seconds, default `1 / 60`)
- Produces: `RootEntry.lastTickTime: number | null`, `RootEntry.accumulatedTime: number`, `RootEntry.maxDelta: number`

- [ ] **Step 1:** Compute timing per root in `tickRoot`:

```ts
const rawDelta = root.lastTickTime === null ? 0 : (timestamp - root.lastTickTime) / 1000
const delta = Math.min(rawDelta, root.maxDelta)
root.lastTickTime = timestamp
root.accumulatedTime += delta
// frameState: { time: timestamp, delta, elapsed: root.accumulatedTime, frame: this.loopState.frameCount }
```

- [ ] **Step 2:** Keep the shared `loopState` update in `executeFrame` — `time` and `frame` stay driver-scoped. Only `delta` and `elapsed` become per-root.
- [ ] **Step 3:** Reset `lastTickTime` to `null` on `registerRoot` and after ambient adoption, so a fresh root's first frame is `0` rather than a huge diff.
- [ ] **Step 4:** Apply the same per-root computation in the `stepJob` path.
- [ ] **Step 5:** Document the default in `docs/concepts.md`: sleeping roots do not accumulate time; a waking demand root receives at most `maxDelta`. Raising `maxDelta` restores v9-style catch-up; `Infinity` reproduces `THREE.Clock.getDelta()` exactly.
- [ ] **Step 6:** Tests — an `always` root's deltas are unchanged from current behavior; a waking demand root gets the same delta whether or not a sibling is running; `elapsed` equals the sum of the deltas that root received; `maxDelta: Infinity` restores catch-up.

### Task 7: Pause compensation sign and frame-count caveat

**Files:**

- Modify: `src/core/scheduler.ts`
- Modify: `docs/scheduler.md`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1:** Fix `startLoop`'s pause compensation. `createdAt - (performance.now() - stoppedTime)` subtracts the paused span where it should add it, so `elapsed` over-counts by twice the pause. Only `stepJob` reads `createdAt`, but the branch makes stop/start far more frequent.
- [ ] **Step 2:** Document that `state.frame` is driver-scoped and resets whenever the RAF restarts, so it is not a stable per-root frame counter in demand-heavy apps. No code change — `frame` is noise only in multi-root start/stop systems, which is acceptable.

---

## Phase 3 — Pre-existing bug fixes

Both of these exist on `main` and are independent of the lifecycle work. Task 9 must land before Task 10.

### Task 8: FPS-throttled jobs receive the wrong delta

`shouldRun` gates _whether_ a job runs, but `tickRoot` hands every job the same root delta. An `fps: 30` job in a 60fps root is invoked every ~33ms and told `delta ≈ 0.0167`, so anything doing `x += delta * speed` runs at half speed. The real interval is already tracked in `job.lastRun`.

**Files:**

- Modify: `src/core/rateLimiter.ts`, `src/core/scheduler.ts`, `src/types.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1:** Have `shouldRun` record the actual interval it consumed (e.g. `job.lastDelta`), respecting both semantics: with `drop: true` the interval is `now - previousLastRun`; with catch-up it is `steps * minInterval`.
- [ ] **Step 2:** In `tickRoot`, pass the per-job delta for throttled jobs and the root delta otherwise. Clamp by `root.maxDelta` so a throttled job in a long-sleeping root cannot teleport either.
- [ ] **Step 3:** Tests — an `fps: 30` job in a 60fps root receives ~0.033; an unthrottled job in the same root still receives ~0.0167; catch-up and drop report their respective intervals.

### Task 9: Unresolvable `before`/`after` targets pollute the global phase graph

`useFrame(fn, { after: 'main' })` with no explicit phase routes through `resolveConstraintPhase` → `ensureAutoPhase`, and because `main` is a job id rather than a phase, `getPhaseIndex` returns -1 and the new phase is **appended after `finish`**. The job runs dead last instead of where it asked, and since `phaseGraph` is one instance shared by every root, the junk `after:main` phase is permanent and global.

Verified: a job with `{ after: 'main' }` alongside `render` and `finish` jobs executes `['render', 'finish', 'wants-after-main']`, and `scheduler.phases.at(-1) === 'after:main'`.

**Files:**

- Modify: `src/core/phaseGraph.ts`, `src/core/scheduler.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1:** Resolve the target in three tiers: a known **phase** keeps today's auto-phase behavior; a known **job id** adopts that job's phase and relies on the existing intra-bucket topological sort; anything else warns and falls back to `update` **without mutating the phase graph**.
- [ ] **Step 2:** The job-id tier needs a lookup at `register` time. Resolve it in `Scheduler.register` before calling `resolveConstraintPhase`, keeping `PhaseGraph` free of job knowledge.
- [ ] **Step 3:** Tests — no phantom phase is created for an unresolvable target; a job-id target lands in the target's phase and sorts after it; an unknown target warns once and defaults to `update`; the existing `{ before: 'render' }` phase-order test still passes.

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

- [ ] **Step 1:** Add `order` to `RootOptions` / `RootEntry`, defaulting to `0`, with ties broken by registration index so unconstrained roots keep today's order exactly.
- [ ] **Step 2:** Maintain a cached sorted root array. Rebuild only on register, unregister, or order change — never per frame.
- [ ] **Step 3:** Have `collectAutomaticRoots` and `executeFrame('all')` iterate the cached array. Sleeping roots are filtered out of the sorted array without re-sorting, and a sleeping root is never forced to run just because another root orders itself after it.
- [ ] **Step 4:** Add `setRootOrder(rootId, order)` for runtime changes; warn and no-op on unknown roots.
- [ ] **Step 5:** Document root-major execution as the contract, and state plainly that ordering reorders whole roots — "all physics across canvases, then all renders" is not expressible.
- [ ] **Step 6:** Tests — reversed registration plus `order` produces the intended sequence; sleeping roots are skipped without disturbing order; runtime order changes take effect on the next frame; adoption preserves order; equal orders fall back to registration index.

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
