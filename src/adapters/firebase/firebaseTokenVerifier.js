import { normalizeEmail, normalizeRequiredId, normalizeRequiredText } from '../../domain/validation.js'

export function createFirebaseTokenVerifier({ auth } = {}) {
  if (!auth || typeof auth !== 'object' || typeof auth.verifyIdToken !== 'function') {
    throw new TypeError('Firebase auth must provide verifyIdToken().')
  }

  return Object.freeze({
    async verifyIdToken(token) {
      const idToken = normalizeRequiredText(token, 'idToken', 8192)
      const decoded = await auth.verifyIdToken(idToken)
      const uid = normalizeRequiredId(decoded?.uid, 'decoded uid')
      const email = normalizeEmail(decoded?.email, 'decoded email')
      return Object.freeze({ uid, email })
    },
  })
}
