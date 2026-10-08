const REQUIRED_METHODS = Object.freeze([
  'create',
  'findPendingByTeacherAndEmail',
  'findByTokenHash',
  'getById',
  'replace',
])

export function assertInvitationRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('invitation repository must be an object.')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`invitation repository must provide ${method}().`)
    }
  }
  return repository
}
