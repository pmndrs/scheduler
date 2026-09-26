import { getScheduler } from '@pmndrs/scheduler'

const box = document.getElementById('box')!
const hud = document.getElementById('hud')!

// No host renderer needed: the first register() creates an ambient root and starts the loop.
const scheduler = getScheduler()

// Spin the box every frame (default 'update' phase).
scheduler.register((state) => {
  box.style.transform = `rotate(${state.elapsed * 90}deg)`
})

// Throttled HUD update at 10fps in the 'finish' phase.
scheduler.register(
  (state) => {
    hud.textContent = `frame ${state.frame} · ${state.elapsed.toFixed(1)}s`
  },
  { phase: 'finish', fps: 10 },
)
