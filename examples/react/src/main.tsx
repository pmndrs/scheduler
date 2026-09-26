import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// No host renderer in this demo: the first useFrame creates an ambient root and starts the loop.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
