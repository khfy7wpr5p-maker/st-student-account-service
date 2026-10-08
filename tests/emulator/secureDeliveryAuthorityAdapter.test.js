import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-st-student-account'
const APP_NAME = `account-secure-delivery-authority-test-${process.pid}`
const app = initializeApp({ projectId: PROJECT_ID }, APP_NAME)
const db = getFirestore(app)

const COLLECTIONS = [
  'identityMappings',
  'identityDomainBindings',
  'teacherStudentGrants',
]

function documentId(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function bindingId(role, stableId) {
  return Buffer.from(JSON.stringify([role, stableId]), 'utf8').toString('base64url')
}

function grantId(teacherId, studentId) {
  return Buffer.from(JSON.stringify([teacherId, studentId]), 'utf8').toString('base64url')
}

async function clearCollections() {
  for (const name of COLLECTIONS) {
    const snapshot = await db.collection(name).get()
    if (snapshot.empty) continue
    const batch = db.batch()
    for (const document of snapshot.docs) batch.delete(document.ref)
    await batch.commit()
  }
}

beforeEach(clearCollections)
after(async () => {
  await clearCollections()
  await deleteApp(app)
})

async function loadAdapter() {
  try {
    return await import('../../src/adapters/secureDelivery/firestoreSecureDeliveryAuthorityPort.js')
  } catch (error) {
    assert.fail(`Secure Delivery authority adapter must load: ${error.message}`)
  }
}

async function seedTeacherAuthority({
  providerSubject = 'firebase-teacher-a',
  teacherId = 'teacher-a',
  active = true,
  disabledAt = null,
} = {}) {
  await db.collection('identityMappings').doc(documentId(providerSubject)).set({
    schemaVersion: 1,
    providerSubject,
    role: 'TEACHER',
    teacherId,
    studentId: null,
    active,
    createdAt: '2026-10-01T10:00:00.000Z',
    disabledAt,
  })
  await db.collection('identityDomainBindings').doc(bindingId('TEACHER', teacherId)).set({
    role: 'TEACHER',
    stableId: teacherId,
    providerSubject,
  })
}

function activation(overrides = {}) {
  return {
    firebaseUid: 'firebase-student-a',
    teacherId: 'teacher-a',
    studentId: 'student-a',
    activatedAt: '2026-10-08T09:45:00.000Z',
    sourceInviteId: 'invite-a',
    ...overrides,
  }
}

test('adapter activates existing Secure Delivery STUDENT identity binding and teacher grant atomically', async () => {
  await seedTeacherAuthority()
  const { createFirestoreSecureDeliveryAuthorityPort } = await loadAdapter()
  const authority = createFirestoreSecureDeliveryAuthorityPort({ db })

  const result = await authority.activateStudent(activation())

  assert.deepEqual(result, {
    studentId: 'student-a',
    teacherId: 'teacher-a',
    identityActive: true,
    grantActive: true,
  })

  assert.deepEqual(
    (await db.collection('identityMappings').doc(documentId('firebase-student-a')).get()).data(),
    {
      schemaVersion: 1,
      providerSubject: 'firebase-student-a',
      role: 'STUDENT',
      teacherId: null,
      studentId: 'student-a',
      active: true,
      createdAt: '2026-10-08T09:45:00.000Z',
      disabledAt: null,
    },
  )
  assert.deepEqual(
    (await db.collection('identityDomainBindings').doc(bindingId('STUDENT', 'student-a')).get()).data(),
    {
      role: 'STUDENT',
      stableId: 'student-a',
      providerSubject: 'firebase-student-a',
    },
  )
  assert.deepEqual(
    (await db.collection('teacherStudentGrants').doc(grantId('teacher-a', 'student-a')).get()).data(),
    {
      schemaVersion: 1,
      teacherId: 'teacher-a',
      studentId: 'student-a',
      active: true,
      createdAt: '2026-10-08T09:45:00.000Z',
      revokedAt: null,
    },
  )
})

test('retry with a later activatedAt converges without rewriting original authority timestamps', async () => {
  await seedTeacherAuthority()
  const { createFirestoreSecureDeliveryAuthorityPort } = await loadAdapter()
  const authority = createFirestoreSecureDeliveryAuthorityPort({ db })

  await authority.activateStudent(activation())
  const replay = await authority.activateStudent(
    activation({ activatedAt: '2026-10-08T09:46:00.000Z' }),
  )

  assert.deepEqual(replay, {
    studentId: 'student-a',
    teacherId: 'teacher-a',
    identityActive: true,
    grantActive: true,
  })
  assert.equal(
    (await db.collection('identityMappings').doc(documentId('firebase-student-a')).get()).data().createdAt,
    '2026-10-08T09:45:00.000Z',
  )
  assert.equal(
    (await db.collection('teacherStudentGrants').doc(grantId('teacher-a', 'student-a')).get()).data().createdAt,
    '2026-10-08T09:45:00.000Z',
  )
})

test('missing or inactive teacher authority fails closed before student authority is created', async () => {
  const { createFirestoreSecureDeliveryAuthorityPort } = await loadAdapter()
  const authority = createFirestoreSecureDeliveryAuthorityPort({ db })

  await assert.rejects(() => authority.activateStudent(activation()), /teacher-authority-unavailable/)
  assert.equal(
    (await db.collection('identityMappings').doc(documentId('firebase-student-a')).get()).exists,
    false,
  )

  await seedTeacherAuthority({ active: false, disabledAt: '2026-10-08T09:40:00.000Z' })
  await assert.rejects(() => authority.activateStudent(activation()), /teacher-authority-unavailable/)
})

test('provider or stable student identity conflicts fail closed and do not create a grant', async () => {
  await seedTeacherAuthority()
  await db.collection('identityMappings').doc(documentId('firebase-student-a')).set({
    schemaVersion: 1,
    providerSubject: 'firebase-student-a',
    role: 'STUDENT',
    teacherId: null,
    studentId: 'student-other',
    active: true,
    createdAt: '2026-10-08T09:00:00.000Z',
    disabledAt: null,
  })
  const { createFirestoreSecureDeliveryAuthorityPort } = await loadAdapter()
  const authority = createFirestoreSecureDeliveryAuthorityPort({ db })

  await assert.rejects(() => authority.activateStudent(activation()), /student-identity-conflict/)
  assert.equal(
    (await db.collection('teacherStudentGrants').doc(grantId('teacher-a', 'student-a')).get()).exists,
    false,
  )
})

test('revoked existing grant is never silently reactivated', async () => {
  await seedTeacherAuthority()
  const { createFirestoreSecureDeliveryAuthorityPort } = await loadAdapter()
  const authority = createFirestoreSecureDeliveryAuthorityPort({ db })
  await authority.activateStudent(activation())

  await db.collection('teacherStudentGrants').doc(grantId('teacher-a', 'student-a')).set({
    schemaVersion: 1,
    teacherId: 'teacher-a',
    studentId: 'student-a',
    active: false,
    createdAt: '2026-10-08T09:45:00.000Z',
    revokedAt: '2026-10-08T09:50:00.000Z',
  })

  await assert.rejects(
    () => authority.activateStudent(activation({ activatedAt: '2026-10-08T10:00:00.000Z' })),
    /grant-revoked/,
  )
  assert.equal(
    (await db.collection('teacherStudentGrants').doc(grantId('teacher-a', 'student-a')).get()).data().active,
    false,
  )
})
