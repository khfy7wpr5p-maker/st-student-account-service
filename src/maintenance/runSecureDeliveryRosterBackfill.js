import { pathToFileURL } from 'node:url'

import { createFirebaseAdminAccess } from '../adapters/firebase/firebaseAdmin.js'
import { createFirestoreSecureDeliveryAuthorityPort } from '../adapters/secureDelivery/firestoreSecureDeliveryAuthorityPort.js'
import { backfillSecureDeliveryRoster } from './backfillSecureDeliveryRoster.js'

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredText(value, name) {
  const text = optionalText(value)
  if (!text) throw new TypeError(`${name} must be configured for roster backfill.`)
  return text
}

function documentId(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function providerNeutral(value) {
  if (value === null || value === undefined) return value
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(providerNeutral)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, providerNeutral(child)]),
    )
  }
  return value
}

function snapshotData(snapshot) {
  return snapshot?.exists ? Object.freeze(providerNeutral(snapshot.data())) : null
}

export async function runSecureDeliveryRosterBackfill({
  env = process.env,
  logger = (event) => console.info(JSON.stringify(event)),
  createAdminAccess = createFirebaseAdminAccess,
  createAuthority = createFirestoreSecureDeliveryAuthorityPort,
} = {}) {
  if (env.ACCOUNT_SERVICE_SECURE_DELIVERY_ROSTER_BACKFILL !== '1') {
    return Object.freeze({ enabled: false, scanned: 0, repaired: 0, skipped: 0 })
  }
  if (typeof logger !== 'function') throw new TypeError('logger must be a function.')
  if (typeof createAdminAccess !== 'function') throw new TypeError('createAdminAccess must be a function.')
  if (typeof createAuthority !== 'function') throw new TypeError('createAuthority must be a function.')

  const projectId = requiredText(env.FIREBASE_PROJECT_ID, 'FIREBASE_PROJECT_ID')
  const secureDeliveryProjectId =
    optionalText(env.SECURE_DELIVERY_FIREBASE_PROJECT_ID) ?? projectId
  if (optionalText(env.SECURE_DELIVERY_AUTHORITY_BINDING) !== 'firestore-v1') {
    throw new TypeError('SECURE_DELIVERY_AUTHORITY_BINDING must be firestore-v1 for roster backfill.')
  }

  const accountAccess = createAdminAccess({
    projectId,
    databaseURL: optionalText(env.FIREBASE_DATABASE_URL),
    appName: 'st-student-account-service-roster-backfill-account',
  })
  const secureAccess = createAdminAccess({
    projectId: secureDeliveryProjectId,
    appName: 'st-student-account-service-roster-backfill-secure-delivery',
  })

  try {
    const accountDb = accountAccess.getFirestore()
    const secureDb = secureAccess.getFirestore()
    const authority = createAuthority({ db: secureDb })

    const result = await backfillSecureDeliveryRoster({
      async listActiveRelationships() {
        const snapshot = await accountDb
          .collection('teacherStudentRelationships')
          .where('active', '==', true)
          .get()
        return snapshot.docs.map((doc) => Object.freeze(providerNeutral(doc.data())))
      },
      async getStudentAccount(studentId) {
        return snapshotData(
          await accountDb.collection('studentAccounts').doc(studentId).get(),
        )
      },
      async hasRosterEntry(studentId) {
        return (
          await secureDb
            .collection('studentRoster')
            .doc(documentId(studentId))
            .get()
        ).exists
      },
      activateStudent: (input) => authority.activateStudent(input),
    })

    logger(Object.freeze({
      event: 'secure_delivery_roster_backfill',
      outcome: 'SUCCESS',
      scanned: result.scanned,
      repaired: result.repaired,
      skipped: result.skipped,
    }))
    return Object.freeze({ enabled: true, ...result })
  } catch {
    logger(Object.freeze({
      event: 'secure_delivery_roster_backfill',
      outcome: 'FAILED',
    }))
    throw new Error('secure-delivery-roster-backfill-failed')
  } finally {
    await Promise.allSettled([
      accountAccess.close?.(),
      secureAccess.close?.(),
    ])
  }
}

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
)

if (isDirectExecution) {
  try {
    await runSecureDeliveryRosterBackfill()
  } catch {
    process.exitCode = 1
  }
}
