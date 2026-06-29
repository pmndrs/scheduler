# Design Note: Ambient Root & Host Adoption

**Status:** Implemented (pre-1.0). Core + React hook + tests landed; r3f-side follow-ups in §12 still owed.
**Goal:** Remove the friction of `scheduler.independent = true` for standalone use, without
breaking react-three-fiber's state delivery. Retire the `independent` concept by making
"there is always a root" the core invariant.

---

## 1. Problem

Today, standalone (no host) usage requires flipping a magic boolean:

```ts
const scheduler = getScheduler()
scheduler.independent = true // <- friction: required before register() does anything
scheduler.register(fn, { phase: 'update' })
```

Without it, `register()` finds no root and no-ops with a warning
([scheduler.ts:419](../../src/core/scheduler.ts#L419)). The `independent` setter's only job is
to call `ensureDefaultRoot()`, which registers a `__default__` root
([scheduler.ts:173](../../src/core/scheduler.ts#L173), [:291](../../src/core/scheduler.ts#L291)).

We want standalone to be **zero-ceremony**: `getScheduler().register(fn)` just works.

## 2. Why we currently "wait" (the load-bearing constraint)

The waiting is **not** in the core — `register()` never waits. It lives in the React
`useFrame` hook: register now if `independent || isReady`, else defer via `onRootReady`
([useFrame.ts:92-100](../../src/hooks/useFrame.ts#L92-L100)).

The reason it must defer is **React's bottom-up effect ordering**: a child `<mesh>`'s
`useFrame` layout effect fires _before_ the parent `<Canvas>`'s root-registration layout
effect. So when a `useFrame` child mounts, the host root does not exist yet. If the child
registered immediately onto a stateless root, its callback would never receive the host
state (camera, gl, scene, pointer) that the Canvas provides via `getState`.

So: **the deferral exists to bind jobs to host state, and it's required because of effect
ordering — not paranoia.**

## 3. Why the obvious fix (flip the default) fails alone

Making `independent` the default breaks r3f: the early child `useFrame` effect would see
`independent === true`, register onto the stateless `__default__` root, and never get host
state. A `getDelayedScheduler()` / opt-out getter can't reliably save it either, because
`independent` is one mutable flag on a **cross-bundle global singleton**
(`Symbol.for('@pmndrs/scheduler')`, [scheduler.ts:64](../../src/core/scheduler.ts#L64)); an
opt-out would have to win the flag globally and deterministically against any other bundle
that already called plain `getScheduler()`. Fragile.

## 4. The design: ambient root + host adoption

Drop the `independent` concept. Adopt one invariant:

> **There is always a root. A "host" is just whoever supplies state to it.**

- `register()` with no existing root **lazily creates the ambient root** (reserved id
  `__default__`). Its `getState` returns `{}` until a host enriches it.
- When a host calls `registerRoot(id, { getState, onError, frameloop })` and the ambient
  root holds **orphan jobs** (jobs registered without an explicit `rootId`), the **first such
  host adopts** them: the ambient root's jobs are migrated into the host root, then the
  ambient root is removed.
- The `useFrame` hook stops gating on `independent || isReady` and drops the `onRootReady`
  wait branch — it just registers. The early child lands on the ambient root; when the
  Canvas mounts microseconds later, it adopts. **Same end state, order-independent instead
  of timing-fragile.**

This collapses the `independent` setter, `onRootReady`, and the hook's wait branch into one
rule — strictly _less_ machinery than today.

## 5. Behavior rules (the contract)

1. **Always a root.** The first `register()` (or first `registerRoot`) guarantees a root
   exists. Standalone never touches a flag.
2. **Ambient root id** is `__default__`, reserved. Users should not pass `rootId:
'__default__'` explicitly; treat it as internal.
3. **Orphan = no explicit `rootId`.** Jobs registered with an explicit `rootId` are bound to
   that root and are **never** adopted/migrated.
4. **First host adopts.** The first `registerRoot` call for a non-ambient root, _while the
   ambient root has orphan jobs_, migrates those jobs into the new root and removes the
   ambient root. Subsequent hosts get their own independent roots and adopt nothing.
5. **Adoption preserves job identity.** Job ids, phase/ordering, fps state, pause state, and
   `jobStateListeners` (keyed by job id, [scheduler.ts:132](../../src/core/scheduler.ts#L132))
   survive migration unchanged. Only the owning root changes.
6. **State enrichment.** After adoption, callbacks receive the host's `getState()` output.
   Before adoption (standalone, or the sub-ms pre-adoption window in r3f) they receive `{}`.
7. **Frameloop / error handler** come from the adopting host
   ([scheduler.ts:210](../../src/core/scheduler.ts#L210)). The host setting `frameloop`
   applies as it does today.
8. **Loop start** happens when the first root gains its first job (ambient creation in the
   standalone case). For r3f this means a sub-millisecond window where the loop may run with
   `{}` state before the Canvas adopts. This is **benign** (nothing renders pre-host; the
   render job is host-supplied) but is a **documented guarantee**, not an accident.

## 6. API surface changes

- **`register(callback, options?)`** — no longer no-ops when rootless; lazily creates the
  ambient root. The "No root registered. Is this inside a Canvas?" warning is **removed from
  the core**. (If we still want to catch "useFrame outside Canvas," that belongs in the hook,
  not the core — see open questions.)
- **`independent` getter/setter** — **removed entirely** (along with the `_independent`
  field and `SchedulerApi.independent`). Standalone is now the default, so the flag is dead
  code; we're the only consumer (r3f) and update it directly, so no deprecation shim is kept.
- **`onRootReady`** — semantics shift: it now fires on _ambient_ creation (≈ first register),
  not on _host_ readiness. Either redefine its doc precisely or deprecate in favor of a
  host-state-ready signal. **Decision needed** (open question Q1).
- **`isReady`** — still `roots.size > 0`; now ≈ always true after first register. Consider a
  separate `hasHost` if consumers need "is a real host attached."
- **`registerRoot`** — gains the adoption step on first non-ambient registration.
- New (optional) explicit hint for hosts that want to suppress the early ambient loop —
  **only if** the pre-adoption window proves problematic. Default design needs none.

## 7. Adoption algorithm (sketch)

```
registerRoot(id, options):
  if id == AMBIENT_ID: (internal path) proceed as today
  create host root as today
  if AMBIENT_ID exists AND ambient has orphan jobs AND this is the first non-ambient root:
      for each job in ambient.jobs:        # all ambient jobs are orphans by definition
          move job -> host root (preserve id, phase, fps, pause, listeners)
          mark host root needsRebuild
      unregisterRoot(AMBIENT_ID)            # without running its "last root stops loop" path
                                            # since the host root now exists
  notify/readiness as redefined
```

Care points:

- `unregisterRoot` currently stops the loop and clears the error handler when `roots.size`
  hits 0 ([scheduler.ts:245-250](../../src/core/scheduler.ts#L245-L250)). During adoption the
  host root already exists, so removing ambient must **not** trip the teardown. Sequence:
  add host root first, migrate, then remove ambient (size never hits 0).
- Don't double-bind the error handler: host `onError` is set on host registration
  ([scheduler.ts:210](../../src/core/scheduler.ts#L210)); ambient had none.

## 8. r3f migration delta

- r3f's `<Canvas>` still calls `registerRoot(id, { getState, onError })` — unchanged call
  site. It now _adopts_ any orphan jobs instead of racing them.
- r3f no longer relies on the hook's `onRootReady` wait. If r3f vendored the wait logic, that
  vendored path can be deleted post-migration. We **document** the first-host-adopts rule and
  the sub-ms `{}`-state window; r3f can adjust if it ever cares (user agreed this is fine).
- Multi-`<Canvas>` apps: first Canvas adopts ambient orphans; additional Canvases are
  independent roots. Jobs that must target a specific Canvas already pass `rootId`.

## 9. Test plan

Core:

- [ ] `register()` with no root creates the ambient root and runs the job (standalone, `{}`
      state).
- [ ] Loop starts on first ambient job; stops when last job/root removed.
- [ ] First host `registerRoot` adopts ambient orphan jobs: ids, phase order, fps throttle
      state, and pause state all preserved.
- [ ] After adoption, callbacks receive host `getState()`; before adoption they receive `{}`.
- [ ] Ambient root is gone after adoption (`getRootCount()` reflects host only).
- [ ] Adoption does **not** trip loop-stop / error-handler-clear teardown.
- [ ] Jobs registered with explicit `rootId` are **not** adopted and stay on their root.
- [ ] Second host registers its own root and adopts nothing.
- [ ] `jobStateListeners` / reactive pause state survive migration (listener still fires).
- [ ] Host `frameloop` and `onError` apply post-adoption.
- [ ] `addPhase` / custom phases on jobs survive migration (needsRebuild honored).

React hook:

- [ ] `useFrame` outside any host (standalone React) registers and runs immediately.
- [ ] Simulated bottom-up effect order (child effect before host root) → child job adopted,
      receives host state on next frame.
- [ ] `isPaused` reactivity intact across adoption.

Back-compat:

- [ ] Existing `scheduler.independent = true` still works (deprecated shim).
- [ ] `onRootReady` fires per its redefined contract.

## 10. Resolved decisions

All three resolved. We control r3f and it is the only consumer today, so these favor what's
best for both systems with clear documentation over extra surface area.

- **Q1 — `onRootReady`: RESOLVED → keep, redefine as "a root exists (ambient counts)."**
  Post-migration nothing consumes it (the hook drops its wait branch; r3f's Canvas knows
  synchronously when it registers its own root), so there is no live caller to surprise.
  Document the shift on the method. Add a distinct `onHostReady`/`hasHost` signal **only** if
  a concrete need appears.

- **Q2 — outside-Canvas warning: RESOLVED → not the core's job, by the model.** Under this
  design **"no host" is a first-class valid state** (standalone-first), so the core cannot
  warn about a missing host without firing on every legitimate standalone user. "useFrame
  outside Canvas is a mistake" is only true _in r3f's world_, because only r3f defines the
  Canvas/host concept. Placement: **core silent, the generic `/react` `useFrame` we ship
  silent (it's host-agnostic and valid standalone), r3f's Canvas-aware layer warns.** Remove
  the core warning at [scheduler.ts:420](../../src/core/scheduler.ts#L420); the
  re-add lives in r3f's repo (tracked in §12).

- **Q3 — pre-adoption `{}`-state loop window: RESOLVED → accept + document, build no hatch
  now.** Synchronous Canvas (normal case) never needs it — the window is one effect flush,
  sub-millisecond. See §13 for the escape hatch we'd add _if_ a real async/lazy-host case
  appears.

## 11. Non-goals

- No change to phases, sorting, fps throttling, demand/manual frame modes, or the public job
  options.
- Not removing multi-root support; ambient + adoption is layered on top of it.
- No rename of `getScheduler` / no new required getter for standalone.

## 12. Follow-ups owed to react-three-fiber (separate repo)

These land in r3f, not here. Tracked so they don't fall through the cracks during the port:

- **Re-add the "useFrame outside Canvas" dev warning** in r3f's Canvas-aware layer (replaces
  the core warning we remove in Q2). Only r3f can distinguish "outside Canvas" because only
  r3f defines the Canvas concept.
- **Delete any vendored wait logic** that mirrored the hook's old `onRootReady` deferral —
  adoption replaces it.
- **Confirm multi-`<Canvas>` behavior** against the first-host-adopts rule (§5.4): first
  Canvas adopts ambient orphans; additional Canvases are independent roots; jobs that must
  target a specific Canvas already pass `rootId`.

## 13. Deferred escape hatch (document only — do NOT build yet)

The pre-adoption `{}`-state window (§5.8, Q3) is benign for synchronous hosts but stretches
for **async/lazy/suspended hosts** (lazy or `Suspense`-d Canvas, a host registered after an
`await`): every frame in the stretched window runs orphan jobs with `{}` state, so a callback
reading e.g. `state.camera` could throw/NaN for the whole stretch rather than one frame.

If that case becomes real, the fix is a host opt-in to defer — **the inverse of the old
`independent` flag**: standalone stays the no-flag default, and slow hosts opt _into_ waiting.
Candidate shapes (pick when needed):

- **`scheduler.expectHost()`** — creates the ambient root but does **not** run its jobs / does
  **not** start the loop until a host adopts (or the caller explicitly releases). Symmetric,
  minimal, explicit.
- **`getScheduler({ deferLoop: true })`** — same intent expressed at acquisition.
- **Reuse existing `frameloop`** — app sets `frameloop = 'never'` before the first job and
  flips it on host-ready. Needs no new API but is blunter: it gates _all_ frames, not just the
  pre-adoption window.

We know the shape; building it now would be speculative. Add it the moment a concrete
lazy/suspended-host case appears, not before.
