# Per-root frameloop design

## Scope

Implement the lifecycle portion of [issue #1](https://github.com/pmndrs/scheduler/issues/1):
keep one application-wide RAF driver while allowing each root to choose its own wake and
execution policy.

Cross-root ordering is intentionally deferred to a separate change.

## Problem

The scheduler currently stores `frameloop` and `pendingFrames` globally. Changing one
canvas from `always` to `demand` therefore cancels the RAF that drives every root.
Invalidating one demand canvas also executes every root.

The driver is correctly global, but root eligibility and demand-frame ownership are not.

## Root lifecycle state

Each `RootEntry` owns:

- `frameloop: 'always' | 'demand' | 'never'`
- `pendingFrames: number`

`RootOptions` accepts an optional `frameloop`. When omitted, a new root uses the
scheduler's current default.

Automatic RAF work exists while at least one root is `always`, or at least one `demand`
root has pending frames. Root counts are expected to be small, so this predicate is
derived by scanning roots instead of maintaining mutation-sensitive counters.

## Public API

- `setRootFrameloop(rootId, mode)` changes one root's mode and reconciles the RAF driver.
- `invalidateRoot(rootId, frames?, stackFrames?)` invalidates one demand root.
- Existing `invalidate(frames?, stackFrames?)` fans out to every demand root.
- Existing `scheduler.frameloop` remains compatible:
  - the getter returns the default used by subsequently registered roots;
  - the setter changes that default and applies the mode to every existing root.
- Existing `start()`, `stop()`, and `step()` remain explicit overrides. `step()` executes
  every root, including `never` roots.

Unknown root IDs are handled consistently with explicit job registration: warn and no-op.
Leaving demand mode clears that root's pending frames so stale work cannot run if the root
later returns to demand mode.

## Frame execution

An automatically driven frame:

1. Updates the scheduler's shared timing state once.
2. Runs global-before jobs.
3. Iterates roots in their existing registration order.
4. Runs every `always` root.
5. Runs a `demand` root only when its `pendingFrames` is greater than zero.
6. Skips every `never` root.
7. Runs global-after jobs.
8. Continues or stops the RAF from the newly derived work predicate.

A demand frame is consumed before its root callbacks run. If a callback invalidates that
root again, the new request remains pending for the next RAF instead of being removed by a
post-callback decrement.

Timing remains scheduler-wide. Roots that execute on the same RAF receive the same
timestamp, delta, elapsed time, and frame number. Introducing per-root clocks is outside
this change.

## Manual driver behavior

Calling `start()` explicitly continues to force a continuous loop and executes all roots,
matching the current low-level behavior. Automatic starts caused by root lifecycle state
do not enable that override. `stop()` cancels either form of loop. `step()` synchronously
executes all roots once without changing automatic lifecycle state.

## Registration and adoption

Registration, unregistration, mode changes, and invalidation reconcile the aggregate RAF
predicate.

Ambient-root adoption requires explicit reconciliation. An ambient root may have started
the loop using the scheduler default, while the adopting host supplies a different mode.
After migration and ambient removal, the host root's mode is authoritative.

## Idle callbacks

`onIdle` remains scheduler-wide. It fires when an automatically driven scheduler has no
remaining work and stops. It does not fire merely because one demand root becomes idle
while another root keeps the driver active.

## Tests

Use a deterministic RAF queue rather than timers. Cover:

- an `always` root continues while a sibling changes to `demand`;
- inactive demand roots are skipped;
- targeted invalidation runs only the selected demand root;
- global invalidation fans out to all demand roots;
- demand roots maintain independent pending-frame counts;
- changing the final active root to demand stops automatic RAF work;
- `never` roots are excluded from automatic frames but included by `step()`;
- invalidation raised inside a demand callback survives for the next frame;
- the 60-frame cap remains per root;
- explicit `start()` and `stop()` retain manual override behavior;
- ambient adoption uses the host's mode and correctly starts or stops the driver;
- the global `frameloop` getter/setter remains compatible for single-root consumers.

The existing `before: 'render'` test is retained as a phase-order invariant, but its
comment is corrected because it does not reproduce issue #1.
