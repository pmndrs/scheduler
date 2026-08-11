# Per-root Frameloop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve one RAF driver while giving every scheduler root an independent `always`, `demand`, or `never` lifecycle.

**Architecture:** Move mode and pending-frame ownership into `RootEntry`, then centralize automatic loop start/stop decisions in a root aggregate predicate. Keep existing global methods as compatibility fan-out controls and add explicit root-scoped mode and invalidation methods.

**Tech Stack:** TypeScript 5.9, Vitest 4, jsdom, pnpm.

## Global Constraints

- Preserve the single application-wide `requestAnimationFrame` driver.
- Preserve global timing and root registration order.
- Do not implement cross-root ordering in this change.
- Keep `scheduler.frameloop`, `invalidate()`, `start()`, `stop()`, and `step()` compatible.
- Use deterministic mocked RAF callbacks for lifecycle tests.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Define root lifecycle API and state

**Files:**

- Modify: `src/types.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Produces: `RootOptions.frameloop?: Frameloop`
- Produces: `RootEntry.frameloop: Frameloop`
- Produces: `RootEntry.pendingFrames: number`
- Produces: `SchedulerApi.setRootFrameloop(rootId: string, mode: Frameloop): void`
- Produces: `SchedulerApi.invalidateRoot(rootId: string, frames?: number, stackFrames?: boolean): void`

- [ ] **Step 1: Add compile-time and behavioral tests for mixed roots**

Add a controlled RAF helper to `tests/scheduler.test.ts`:

```ts
const createRafController = () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 1

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))

  return {
    flush(timestamp: number) {
      const queued = [...callbacks.values()]
      callbacks.clear()
      for (const callback of queued) callback(timestamp)
    },
    get size() {
      return callbacks.size
    },
  }
}
```

Test roots registered with `{ frameloop: 'always' }`, `{ frameloop: 'demand' }`, and
`{ frameloop: 'never' }`. Verify only the always root runs on automatic frames.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/scheduler.test.ts`

Expected: TypeScript/runtime failures because root lifecycle fields and methods do not exist.

- [ ] **Step 3: Extend public and internal types**

In `src/types.ts`, add:

```ts
export interface RootOptions {
  getState?: () => any
  onError?: (error: Error) => void
  frameloop?: Frameloop
}

export interface RootEntry {
  // Existing fields...
  frameloop: Frameloop
  pendingFrames: number
}
```

Extend `SchedulerApi` with the two root-scoped methods listed in this task's Interfaces.

- [ ] **Step 4: Run typecheck to verify the implementation now requires root initialization**

Run: `pnpm typecheck`

Expected: failure in `Scheduler.registerRoot` until it initializes both new required fields.

---

### Task 2: Implement root lifecycle selection and driver reconciliation

**Files:**

- Modify: `src/core/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**

- Consumes: root lifecycle types from Task 1
- Produces: root-scoped mode updates and invalidation
- Produces: automatic RAF selection by root

- [ ] **Step 1: Initialize lifecycle state during root registration**

Create each root with:

```ts
frameloop: options.frameloop ?? this._frameloop,
pendingFrames: 0,
```

Replace first-root-only start logic with a call to one reconciliation method after registration
and ambient adoption.

- [ ] **Step 2: Add root work predicates**

Add helpers equivalent to:

```ts
private shouldTickRoot(root: RootEntry): boolean {
  return root.frameloop === 'always' || (root.frameloop === 'demand' && root.pendingFrames > 0);
}

private hasAutomaticWork(): boolean {
  for (const root of this.roots.values()) {
    if (this.shouldTickRoot(root)) return true;
  }
  return false;
}
```

Use one reconciliation path to start the RAF when automatic work appears and stop it when
automatic work disappears.

- [ ] **Step 3: Implement mode updates**

Implement `setRootFrameloop`. Unknown root IDs warn and no-op. Leaving demand mode clears
pending frames. Reconcile once after mutation.

Update the global `frameloop` setter so it stores the default, applies the mode to every root,
clears stale pending frames where needed, and reconciles once.

- [ ] **Step 4: Implement targeted and fan-out invalidation**

Implement `invalidateRoot` using the existing replace/stack semantics and a per-root cap of 60.
Only demand roots accept invalidation.

Change `invalidate()` to iterate all demand roots, apply the same update, and reconcile once.

- [ ] **Step 5: Select roots during automatic frames**

Separate automatic execution from manual stepping. Automatic RAF execution skips inactive
demand roots and never roots. Manual `step()` continues to tick every root.

For an eligible demand root, decrement its pending count immediately before `tickRoot`; this
preserves invalidations raised by its own callbacks.

- [ ] **Step 6: Reconcile after callbacks and mutations**

After each RAF execution, schedule the next callback only if automatic work remains. Otherwise
notify scheduler-wide idle callbacks once and stop. Ensure unregistering a root and ambient
adoption also reconcile.

- [ ] **Step 7: Run focused tests**

Run: `pnpm vitest run tests/scheduler.test.ts`

Expected: all scheduler tests pass.

---

### Task 3: Complete lifecycle regression coverage

**Files:**

- Modify: `tests/scheduler.test.ts`

**Interfaces:**

- Consumes: `setRootFrameloop`, `invalidateRoot`, and global compatibility methods
- Produces: deterministic regression coverage for issue #1

- [ ] **Step 1: Test independent runtime mode changes**

Verify changing one root from always to demand does not stop or skip a sibling always root.
Verify changing the final always root to demand leaves no RAF queued.

- [ ] **Step 2: Test targeted and fan-out invalidation**

Verify `invalidateRoot` executes only its selected demand root. Verify `invalidate()` executes
all demand roots but not never roots.

- [ ] **Step 3: Test independent pending counts and replacement semantics**

Give two demand roots different frame counts and verify each executes exactly its own count.
Verify replace, stack, and the 60-frame cap.

- [ ] **Step 4: Test callback re-invalidation**

Have a one-frame demand callback call `invalidateRoot` for itself. Verify it executes once more
on the following RAF.

- [ ] **Step 5: Test manual and adoption behavior**

Verify `step()` includes demand and never roots without consuming pending counts. Verify an
always ambient root adopted by a demand host stops automatic work, and a demand ambient root
adopted by an always host starts it.

- [ ] **Step 6: Correct the unrelated regression label**

Keep the existing same-root `before: 'render'` assertion, but remove wording that identifies it
as GitHub issue #1.

- [ ] **Step 7: Run scheduler tests**

Run: `pnpm vitest run tests/scheduler.test.ts`

Expected: all scheduler tests pass with deterministic RAF behavior.

---

### Task 4: Update documentation and verify the package

**Files:**

- Modify: `README.md`
- Modify: `docs/concepts.md`
- Modify: `docs/scheduler.md`
- Modify: `docs/design/ambient-root.md`

**Interfaces:**

- Consumes: final lifecycle API and semantics
- Produces: public documentation for mixed-root consumers

- [ ] **Step 1: Document the root lifecycle model**

Explain that the RAF driver remains global while mode and demand frames are per root. Document
`RootOptions.frameloop`, `setRootFrameloop`, `invalidateRoot`, global fan-out invalidation, the
legacy default/fan-out meaning of `scheduler.frameloop`, manual stepping, and scheduler-wide
idle callbacks.

- [ ] **Step 2: Correct ambient-root documentation**

State that the adopting host's mode wins and loop state is reconciled after adoption.

- [ ] **Step 3: Run static verification**

Run: `pnpm typecheck && pnpm lint && pnpm format`

Expected: all commands exit successfully.

- [ ] **Step 4: Run tests and build**

Run: `pnpm test && pnpm build`

Expected: all tests pass and package output builds successfully.

- [ ] **Step 5: Inspect final changes**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned source, test, and documentation files are changed.
