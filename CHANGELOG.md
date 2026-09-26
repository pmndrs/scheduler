# Changelog

//* Unreleased ===============================================================

- `useFrame` applies option changes in place with `updateJob` instead of re-registering. The job keeps its id, ordering slot among equal priorities, throttle timing, pause state, and `isPaused` subscription across option changes; only changed fields are sent, so an imperative `pause()` isn't undone by an unrelated option change.
- `useFrame` auto-generated ids now come from `scheduler.generateJobId()` (new public method) instead of React's `useId`, which is only unique within one React root and could collide across canvases.
- `updateJob` keys on presence: `{ fps: undefined }` clears the throttle and `{ phase: undefined }` re-derives the phase, while absent keys are untouched. It also re-sorts on `priority` changes, which it previously missed.
- A `before`/`after` constraint that the phase order makes impossible (`{ phase: 'update', after: 'camera' }` with `camera` in `render`) now warns once per job instead of being silently ignored. The explicit phase still wins.
- `onError` is now per root: a job error dispatches to the handler of the root that owns the job. Previously the last-registered root's handler received every root's errors. Roots without a handler fall back to the scheduler-wide one, then `console.error`.
- Fixed: the unsubscribe returned by `register()` / `useFrame` did nothing once a host had adopted the job from the ambient root, so unmounted `useFrame` callbacks kept running. It now removes exactly the job it registered, wherever it lives.
- Fixed: a callback that stopped and restarted the driver (`stop()` + `start()`, or unregistering the last root and registering another) left two RAF loops alive, ticking every job twice per frame.
- Fixed: unthrottled jobs received a fresh copy of the frame state nearly every frame because their delta was re-derived by float differencing. They now share the root's state object and exact delta; only `fps`-throttled jobs get their own interval. Roughly 9x less per-job overhead on large roots.
- Fixed: `useFrame` did not register when its callback went from `undefined` to a function after mount.
- Fixed: a throttled job now always runs on its first frame instead of depending on the timestamp's magnitude.
- Fixed: registering a job in a realm without `requestAnimationFrame` (Node, some workers) threw; it now falls back to a ~60Hz timer.
- Job lookups by id (`updateJob`, `pauseJob`, `getJobRootId`, …) are O(1) via an id index. Reusing a job id on a second root now warns.
- Removed the dead HMR preservation block (its `import.meta.hot` probe could never succeed and needed `unsafe-eval`). The `Symbol.for` global already keeps the instance across hot reloads. `HMRData` is deprecated.
- Examples no longer set the removed `independent` flag.

//* 0.2.0 — 2026-08-24 =======================================================

- Added per-root frameloop lifecycle, targeted invalidation, the new `stepRoot()` API for per-root manual stepping, and root/job introspection while preserving the application-wide RAF driver.
- Added per-root `delta` and `elapsed` timing with configurable `maxDelta`.
- Added deterministic root execution through numeric order and `before`/`after` dependencies.
- Preserved the bulk frameloop APIs: `scheduler.frameloop` still applies to all roots and now warns once in multi-root use, while `invalidate()` still fans out to demand roots.
- Made `stop()` sticky until `start()` or explicit invalidation resumes the driver.
- Preserved demand behavior: entering demand grants no implicit frame, and demand roots draw only after explicit invalidation.
- `getRootIds()` now reports root execution order.
- FPS-throttled jobs now receive the real interval since their previous run.
