import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { getScheduler } from '@pmndrs/scheduler'
import { App } from './App'

// No host renderer in this demo — let the scheduler run on its own.
getScheduler().independent = true

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
