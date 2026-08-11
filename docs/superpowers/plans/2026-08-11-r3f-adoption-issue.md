# Draft: issue for pmndrs/react-three-fiber

> Working copy. File against `pmndrs/react-three-fiber`, then delete this file (Task 12 of `2026-08-11-lifecycle-followups.md`).
>
> Line references are against `611635d3`. Re-check them before filing.

---

**Title:** Multi-canvas: per-`<Canvas>` `frameloop` is applied globally, so one canvas idling freezes every other canvas

**Labels:** bug, v10

---

## Summary

`<Canvas frameloop="...">` is a per-canvas prop, but r3f mirrors it onto the _global_ scheduler mode. With several canvases the effective mode is last-writer-wins, and because `configure()` re-runs on every render, canvases actively overwrite each other's modes as you scroll. `invalidate()` and `advance()` are global for the same reason.

This is the r3f half of [pmndrs/scheduler#1](https://github.com/pmndrs/scheduler/issues/1); the original downstream report is #3852. Upstream now supports per-root lifecycle (`setRootFrameloop`, `invalidateRoot`, `stepRoot`, per-root `pendingFrames`) as of `@pmndrs/scheduler@0.2.0`, so the fix is now a matter of r3f calling the root-scoped APIs. **Upgrading the scheduler dependency alone changes nothing** — the global writes below have to go with it.

## Reproduction

A page with a hero canvas (`id="main"`) plus section canvases sharing its renderer, where the hero idles itself when scrolled out of view:

```tsx
<Canvas id="main" frameloop={onScreen ? 'always' : 'demand'}>
  …
</Canvas>
```

Every other canvas freezes the moment the hero leaves the viewport and resumes when it returns. Measurements of a secondary canvas's `delta` across the transition are in pmndrs/scheduler#1.

It fails silently — frozen canvases keep presenting their last drawn frame, so nothing errors or blanks, and it reads as "static by design".

## Cause

Six call sites, all writing global scheduler state:

| Location                 | Problem                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer.tsx:771`       | `scheduler.frameloop = frameloop` at the end of every `configure()`                                                                                                                         |
| `Canvas.tsx:131`         | the layout effect calling `configure()` has **no dependency array**, so it runs on every render; `useMeasure` is configured with `scroll: true`, so scrolling re-measures and re-configures |
| `store.ts:213`           | `setFrameloop` mirrors onto the global mode                                                                                                                                                 |
| `store.ts:106, 181, 200` | `state.invalidate()` fans out to every demand root                                                                                                                                          |
| `legacy.ts:137`          | `advance()` → `scheduler.step()`, which ticks **every** root                                                                                                                                |
| `renderer.tsx:638`       | `registerRoot` doesn't pass `frameloop`, so a `frameloop="demand"` canvas registers as `always` and runs frames until the setter lands                                                      |

The combination of the first two is what makes this continuous rather than a one-time race: every Canvas pushes its own `frameloop` onto every root, on every render.

Two consequences worth calling out separately:

- **`advance()` now double-ticks.** With per-root `never` available, an XR or manually-driven canvas next to an `always` canvas ticks that sibling twice per frame — once from the RAF, once from `advance()`. `handleXRFrame` (`renderer.tsx:514`) drives this continuously while presenting. Previously `frameloop="never"` was global, so it couldn't arise.
- **`scheduler.stop()` doesn't stay stopped** in current r3f, because the next Canvas render writes `scheduler.frameloop` and restarts the driver. Fixed upstream in `0.2.0`, but the r3f-side global write has to go too.

## Proposed change

Requires `@pmndrs/scheduler@^0.2.0`.

1. **`renderer.tsx:638`** — pass the mode at registration: `scheduler.registerRoot(newRootId, { getState, onError, frameloop })`.
2. **`renderer.tsx:771`** — `scheduler.setRootFrameloop(rootId, frameloop)`. Note the local `rootId` is read _before_ the `if (!rootId)` block creates it, so use `newRootId` on the first pass.
3. **`store.ts:213`** — `setFrameloop` → `getScheduler().setRootFrameloop(get().internal.rootId, frameloop)`.
4. **`store.ts:106, 181, 200`** — `state.invalidate()` → `invalidateRoot(internal.rootId, …)`.
5. **`legacy.ts:121`** — leave the exported `invalidate()` as a global fan-out. drei and friends import it standalone with no state to scope by, so this one must stay global. The store-bound `state.invalidate()` is the one that becomes root-scoped.
6. **`legacy.ts:137` / `renderer.tsx:514`** — `advance()` → `stepRoot(rootId, timestamp)`. `advance()`'s public signature takes no state, so either resolve the root from the calling store or add an optional root argument; the XR path has the store in scope either way.

## Tests worth adding

- Two canvases, one switched to `demand`: the other keeps ticking.
- `invalidate()` from one canvas doesn't render the other.
- A canvas re-rendering (prop change, resize, scroll) doesn't reset a sibling's mode — this is the regression that makes the bug continuous.
- `advance()` on a `never` canvas doesn't tick an `always` sibling.
- `frameloop="demand"` canvas renders no frames before its first `invalidate()`.

## Not included

Cross-root ordering. `renderer={{ scheduler: { after: 'main' } }}` currently attaches `after` to that root's _render job_, and job constraints are only resolved within a single root, so a cross-canvas reference is silently dropped — it appears to work only because the primary canvas usually registers first. Tracked separately upstream; it needs root-level ordering in the scheduler before r3f can pass it through.

Worth knowing for whoever picks that up: r3f uses `canvasId` as both the root id and the render job id (`renderer.tsx:637`, `renderer.tsx:742`), so `after: 'main'` reads identically whether it's interpreted as a root or a job reference. Migrating it to root level won't change anyone's config. The wrinkle is that `fps` lives in the same config bag and stays job-level, so that object would then span two levels of the scheduler API.
