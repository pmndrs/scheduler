//* @pmndrs/scheduler — Vanilla Entry ==============================
//
// Framework-agnostic frame scheduler. Zero React, zero three.
//
// @example
// import { getScheduler } from '@pmndrs/scheduler'
//
// const scheduler = getScheduler()
// scheduler.register((state, delta) => {
//   // called every frame — no host renderer required
// }, { phase: 'update' })

export { Scheduler, getScheduler } from './core/scheduler'
export * from './types'
