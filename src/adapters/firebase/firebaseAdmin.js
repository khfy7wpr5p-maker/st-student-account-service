import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

function defaultAppFactory(options, appName) {
  const existing = getApps().find((app) => app.name === appName)
  return existing ?? initializeApp(options, appName)
}

export function createFirebaseAdminAccess({
  projectId,
  credential,
  emulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST),
  appName = 'st-student-account-service',
  appFactory = defaultAppFactory,
  authFactory = getAuth,
} = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new TypeError('projectId must be a non-empty string.')
  }
  if (typeof appName !== 'string' || !appName.trim()) {
    throw new TypeError('appName must be a non-empty string.')
  }
  if (typeof emulator !== 'boolean') {
    throw new TypeError('emulator must be boolean.')
  }
  if (typeof appFactory !== 'function' || typeof authFactory !== 'function') {
    throw new TypeError('Firebase Admin factories must be functions.')
  }

  let auth = null
  return Object.freeze({
    getAuth() {
      if (auth) return auth
      const options = { projectId: projectId.trim() }
      if (credential) {
        options.credential = credential
      } else if (!emulator) {
        options.credential = applicationDefault()
      }
      const app = appFactory(options, appName.trim())
      auth = authFactory(app)
      return auth
    },
  })
}
