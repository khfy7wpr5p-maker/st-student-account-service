import { normalizeEmail } from '../../domain/validation.js'

export function createFirebaseAuthDirectory({ auth } = {}) {
  if (!auth || typeof auth !== 'object' || typeof auth.getUserByEmail !== 'function') {
    throw new TypeError('Firebase auth must provide getUserByEmail().')
  }

  return Object.freeze({
    async accountExistsByEmail(email) {
      const emailNormalized = normalizeEmail(email)
      try {
        await auth.getUserByEmail(emailNormalized)
        return true
      } catch (error) {
        if (error?.code === 'auth/user-not-found') return false
        throw error
      }
    },
  })
}
