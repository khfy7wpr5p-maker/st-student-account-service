import { applicationDefault, deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore } from 'firebase-admin/firestore'

function defaultAppFactory(options, appName) {
  const existing = getApps().find((app) => app.name === appName)
  return existing ?? initializeApp(options, appName)
}

function detectEmulatorEnvironment(env = process.env) {
  return Boolean(
    env.FIREBASE_AUTH_EMULATOR_HOST ||
    env.FIRESTORE_EMULATOR_HOST ||
    env.FIREBASE_DATABASE_EMULATOR_HOST,
  )
}

export function createFirebaseAdminAccess({
  projectId,
  databaseURL,
  credential,
  emulator = detectEmulatorEnvironment(),
  appName = 'st-student-account-service',
  appFactory = defaultAppFactory,
  authFactory = getAuth,
  firestoreFactory = getFirestore,
  databaseFactory = getDatabase,
  credentialFactory = applicationDefault,
  deleteAppFactory = deleteApp,
} = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new TypeError('projectId must be a non-empty string.')
  }
  if (databaseURL !== undefined && (typeof databaseURL !== 'string' || !databaseURL.trim())) {
    throw new TypeError('databaseURL must be a non-empty string when provided.')
  }
  if (typeof appName !== 'string' || !appName.trim()) {
    throw new TypeError('appName must be a non-empty string.')
  }
  if (typeof emulator !== 'boolean') {
    throw new TypeError('emulator must be boolean.')
  }
  for (const [name, factory] of Object.entries({
    appFactory,
    authFactory,
    firestoreFactory,
    databaseFactory,
    credentialFactory,
    deleteAppFactory,
  })) {
    if (typeof factory !== 'function') {
      throw new TypeError(`${name} must be a function.`)
    }
  }

  let app = null
  let auth = null
  let firestore = null
  let database = null
  let closed = false

  function getApp() {
    if (closed) throw new Error('firebase-admin-access-closed')
    if (app) return app
    const options = { projectId: projectId.trim() }
    if (databaseURL) options.databaseURL = databaseURL.trim()
    if (credential) {
      options.credential = credential
    } else if (!emulator) {
      options.credential = credentialFactory()
    }
    app = appFactory(options, appName.trim())
    return app
  }

  return Object.freeze({
    getAuth() {
      if (!auth) auth = authFactory(getApp())
      return auth
    },
    getFirestore() {
      if (!firestore) firestore = firestoreFactory(getApp())
      return firestore
    },
    getDatabase() {
      if (!database) database = databaseFactory(getApp())
      return database
    },
    async close() {
      if (closed) return
      closed = true
      const currentApp = app
      app = null
      auth = null
      firestore = null
      database = null
      if (currentApp) await deleteAppFactory(currentApp)
    },
  })
}
