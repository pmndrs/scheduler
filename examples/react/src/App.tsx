import * as React from 'react'
import { useFrame } from '@pmndrs/scheduler/react'

export function App() {
  const ref = React.useRef<HTMLDivElement>(null)
  const [frame, setFrame] = React.useState(0)

  // Spin a box every frame.
  useFrame((state) => {
    if (ref.current) ref.current.style.transform = `rotate(${state.elapsed * 90}deg)`
  })

  // Update a counter, throttled to 5fps, and expose pause/resume controls.
  const counter = useFrame((state) => setFrame(state.frame), { fps: 5, phase: 'finish' })

  return (
    <div style={{ display: 'grid', gap: 16, placeItems: 'center' }}>
      <div ref={ref} style={{ width: 80, height: 80, background: '#6366f1', borderRadius: 12 }} />
      <div>frame {frame}</div>
      <button onClick={() => (counter.isPaused ? counter.resume() : counter.pause())}>
        {counter.isPaused ? 'resume counter' : 'pause counter'}
      </button>
    </div>
  )
}
