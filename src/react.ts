//* @pmndrs/scheduler/react — React Entry ==============================
//
// The `useFrame` hook plus direct access to the global scheduler.
// React and react-dom are optional peer dependencies, only needed here.
//
// @example
// import { useFrame } from '@pmndrs/scheduler/react'
//
// function Spinner() {
//   useFrame((state, delta) => { ... })
//   return null
// }

export { useFrame } from './hooks/useFrame'
export { useMutableCallback, useIsomorphicLayoutEffect } from './hooks/utils'
export { Scheduler, getScheduler } from './core/scheduler'
export * from './types'
