import { getScheduler } from '@pmndrs/scheduler'

const box = document.getElementById('box')!
const ball = document.getElementById('ball')!
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

// A bouncing ball simulated in the 'physics' phase, which is a fixed phase at
// 1/60 by default: dt is exactly 1/60 every call, and a slow frame runs the
// phase more than once to catch up. The render phase interpolates between the
// previous and current simulation states with state.overstep.
const gravity = -2000 // px/s²
let prevY = 0
let currY = 300
let velocity = 0

scheduler.register(
  (state, dt) => {
    prevY = currY
    velocity += gravity * dt
    currY += velocity * dt
    if (currY < 0) {
      currY = -currY
      velocity = -velocity * 0.9
    }
  },
  { phase: 'physics' },
)

scheduler.register(
  (state) => {
    const y = prevY + (currY - prevY) * state.overstep
    ball.style.transform = `translateY(${-y}px)`
  },
  { phase: 'render' },
)
