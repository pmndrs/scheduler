# Changelog

//* 0.2.0 — 2026-08-24 =======================================================

- Added per-root frameloop lifecycle, targeted invalidation, the new `stepRoot()` API for per-root manual stepping, and root/job introspection while preserving the application-wide RAF driver.
- Added per-root `delta` and `elapsed` timing with configurable `maxDelta`.
- Added deterministic root execution through numeric order and `before`/`after` dependencies.
- Preserved the bulk frameloop APIs: `scheduler.frameloop` still applies to all roots and now warns once in multi-root use, while `invalidate()` still fans out to demand roots.
- Made `stop()` sticky until `start()` or explicit invalidation resumes the driver.
- Preserved demand behavior: entering demand grants no implicit frame, and demand roots draw only after explicit invalidation.
- `getRootIds()` now reports root execution order.
- FPS-throttled jobs now receive the real interval since their previous run.
