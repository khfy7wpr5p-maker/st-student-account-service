import { normalizeRequiredId } from '../../domain/validation.js'

const TEACHER_ROLE = 'TEACHER'

function documentId(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function bindingId(role, stableId) {
  return Buffer.from(
    JSON.stringify([role, stableId]),
    'utf8',
  ).toString('base64url')
}

function assertFirestore(db) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('db must provide Firestore collection().')
  }
  return db
}

function activeTeacherIdentity(raw, providerSubject) {
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    raw.providerSubject !== providerSubject ||
    raw.role !== TEACHER_ROLE ||
    typeof raw.teacherId !== 'string' ||
    raw.studentId !== null ||
    raw.active !== true ||
    raw.disabledAt !== null
  ) {
    return null
  }

  try {
    return normalizeRequiredId(raw.teacherId, 'teacherId')
  } catch {
    return null
  }
}

function matchingBinding(raw, { teacherId, providerSubject }) {
  return Boolean(
    raw &&
    raw.role === TEACHER_ROLE &&
    raw.stableId === teacherId &&
    raw.providerSubject === providerSubject
  )
}

export function createFirestoreSecureDeliveryTeacherIdentityResolver({ db } = {}) {
  const firestore = assertFirestore(db)
  const identities = firestore.collection('identityMappings')
  const bindings = firestore.collection('identityDomainBindings')

  return Object.freeze({
    async resolveTeacher(firebaseUid) {
      let providerSubject
      try {
        providerSubject = normalizeRequiredId(firebaseUid, 'firebaseUid')
      } catch {
        return null
      }

      const identitySnapshot = await identities
        .doc(documentId(providerSubject))
        .get()
      if (!identitySnapshot.exists) return null

      const teacherId = activeTeacherIdentity(
        identitySnapshot.data(),
        providerSubject,
      )
      if (teacherId === null) return null

      const bindingSnapshot = await bindings
        .doc(bindingId(TEACHER_ROLE, teacherId))
        .get()
      if (!bindingSnapshot.exists) return null
      if (!matchingBinding(bindingSnapshot.data(), { teacherId, providerSubject })) {
        return null
      }

      return Object.freeze({
        teacherId,
        active: true,
      })
    },
  })
}
