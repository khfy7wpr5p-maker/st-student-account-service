import { addDays, normalizeRequiredId, normalizeTimestamp } from '../domain/validation.js'
import { assertClock } from '../ports/clock.js'
import { assertStudentAccountRepository } from '../ports/studentAccountRepository.js'
import { assertTokenVerifier } from '../ports/tokenVerifier.js'
import { assertUsageRepository } from '../ports/usageRepository.js'

function unauthorized() {
  const error = new Error('student-session-unauthorized')
  error.code = 'UNAUTHORIZED'
  return error
}

function normalizeClientSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) {
    throw new TypeError('clientSessionId must be a bounded identifier.')
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError('clientSessionId must be path-safe.')
  }
  return value
}

export function recordStudentSessionService({
  tokenVerifier,
  studentAccountRepository,
  usageRepository,
  clock,
} = {}) {
  const verifier = assertTokenVerifier(tokenVerifier)
  const accounts = assertStudentAccountRepository(studentAccountRepository)
  const usage = assertUsageRepository(usageRepository)
  const time = assertClock(clock)

  return Object.freeze({
    async execute({ bearerToken, clientSessionId } = {}) {
      if (typeof bearerToken !== 'string' || bearerToken.length === 0) throw unauthorized()
      const sessionId = normalizeClientSessionId(clientSessionId)

      let authenticated
      try {
        authenticated = await verifier.verifyIdToken(bearerToken)
      } catch {
        throw unauthorized()
      }

      let firebaseUid
      try {
        firebaseUid = normalizeRequiredId(authenticated?.uid, 'authenticated uid')
      } catch {
        throw unauthorized()
      }

      const account = await accounts.findByFirebaseUid(firebaseUid)
      if (!account || account.active !== true) {
        throw new Error('student-account-forbidden')
      }

      const startedAt = normalizeTimestamp(time.now(), 'clock.now()')
      const expiresAt = addDays(startedAt, 30)
      return usage.recordSessionOnce({
        studentId: account.studentId,
        clientSessionId: sessionId,
        startedAt,
        expiresAt,
      })
    },
  })
}
