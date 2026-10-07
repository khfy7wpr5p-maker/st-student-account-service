const REQUIRED_METHODS = Object.freeze(['recordSessionOnce'])

export function assertUsageRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('usage repository must be an object.')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`usage repository must provide ${method}().`)
    }
  }
  return repository
}
