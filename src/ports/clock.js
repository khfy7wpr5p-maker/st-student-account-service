export function assertClock(clock) {
  if (!clock || typeof clock !== 'object' || typeof clock.now !== 'function') throw new TypeError('clock must provide now().')
  return clock
}
export function createSystemClock(){return Object.freeze({now:()=>new Date().toISOString()})}
