const BOUNDED = Object.freeze({
  UNAUTHORIZED: Object.freeze({ status: 401, body: Object.freeze({ error: 'UNAUTHORIZED' }) }),
  FORBIDDEN: Object.freeze({ status: 403, body: Object.freeze({ error: 'FORBIDDEN' }) }),
  INVALID_REQUEST: Object.freeze({ status: 400, body: Object.freeze({ error: 'INVALID_REQUEST' }) }),
  NOT_FOUND: Object.freeze({ status: 404, body: Object.freeze({ error: 'NOT_FOUND' }) }),
  CONFLICT: Object.freeze({ status: 409, body: Object.freeze({ error: 'CONFLICT' }) }),
  SERVICE_UNAVAILABLE: Object.freeze({ status: 503, body: Object.freeze({ error: 'SERVICE_UNAVAILABLE' }) }),
  INTERNAL_ERROR: Object.freeze({ status: 500, body: Object.freeze({ error: 'INTERNAL_ERROR' }) }),
})

function copy(result) {
  return { status: result.status, body: { ...result.body } }
}

export function boundaryError(code) {
  const error = new Error(String(code).toLowerCase())
  error.code = code
  return error
}

export function toHttpError(error) {
  if (error?.code === 'UNAUTHORIZED') return copy(BOUNDED.UNAUTHORIZED)
  if (error?.code === 'FORBIDDEN') return copy(BOUNDED.FORBIDDEN)
  if (error?.code === 'SERVICE_UNAVAILABLE') return copy(BOUNDED.SERVICE_UNAVAILABLE)
  if (error instanceof TypeError || error?.type === 'entity.parse.failed') {
    return copy(BOUNDED.INVALID_REQUEST)
  }

  const message = typeof error?.message === 'string' ? error.message : ''
  if (message.includes('not-found')) return copy(BOUNDED.NOT_FOUND)
  if (
    message.includes('conflict') ||
    message.includes('expired') ||
    message.includes('unavailable') ||
    message.includes('already')
  ) {
    return copy(BOUNDED.CONFLICT)
  }
  if (message.includes('forbidden')) return copy(BOUNDED.FORBIDDEN)
  return copy(BOUNDED.INTERNAL_ERROR)
}
