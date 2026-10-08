const REQUIRED_METHODS = Object.freeze([
  'findByFirebaseUid',
  'createActivating',
  'markActive',
])

export function assertStudentAccountRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('student account repository must be an object.')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`student account repository must provide ${method}().`)
    }
  }
  return repository
}
