const REQUIRED_METHODS = Object.freeze([
  'beginActivation',
  'markActive',
  'getBySourceInviteId',
])

export function assertRelationshipRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('relationship repository must be an object.')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`relationship repository must provide ${method}().`)
    }
  }
  return repository
}
