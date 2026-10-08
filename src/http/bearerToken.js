function unauthorized() {
  const error = new Error('unauthorized')
  error.code = 'UNAUTHORIZED'
  return error
}

export function readBearerToken(request) {
  const authorization = request?.headers?.authorization
  if (typeof authorization !== 'string') throw unauthorized()
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  if (!match) throw unauthorized()
  return match[1]
}
