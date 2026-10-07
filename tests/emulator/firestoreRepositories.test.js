import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { acceptStudentInvitation, createStudentInvitation } from '../../src/domain/studentInvitation.js'
import { createStudentAccount } from '../../src/domain/studentAccount.js'
import { createTeacherStudentRelationship } from '../../src/domain/teacherStudentRelationship.js'

const PROJECT_ID = 'demo-st-student-account'
const APP_NAME = `account-firestore-test-${process.pid}`
const app = initializeApp({ projectId: PROJECT_ID }, APP_NAME)
const db = getFirestore(app)

const COLLECTIONS = [
  'studentInvitations',
  'studentInvitationPendingLocks',
  'studentAccounts',
  'studentAccountUidMappings',
  'teacherStudentRelationships',
  'teacherStudentRelationshipSources',
]

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

async function loadAdapters() {
  try {
    const [invitationModule, accountModule, relationshipModule] = await Promise.all([
      import('../../src/adapters/firebase/firestoreInvitationRepository.js'),
      import('../../src/adapters/firebase/firestoreStudentAccountRepository.js'),
      import('../../src/adapters/firebase/firestoreRelationshipRepository.js'),
    ])
    return { ...invitationModule, ...accountModule, ...relationshipModule }
  } catch (error) {
    assert.fail(`Firestore adapters must load: ${error.message}`)
  }
}

function invitation({
  inviteId = 'invite-a',
  teacherId = 'teacher-a',
  email = 'student@example.com',
  tokenHash = 'a'.repeat(64),
} = {}) {
  return createStudentInvitation({
    inviteId,
    teacherId,
    email,
    studentDisplayNameOrNickname: 'Ayşe',
    tokenHash,
    createdAt: '2026-10-07T18:00:00.000Z',
  })
}

function account({
  studentId = 'student-a',
  firebaseUid = 'firebase-uid-a',
  email = 'student@example.com',
} = {}) {
  return createStudentAccount({
    studentId,
    firebaseUid,
    email,
    createdAt: '2026-10-07T18:00:00.000Z',
    active: false,
  })
}

function relationship({
  relationshipId = 'relationship-a',
  teacherId = 'teacher-a',
  studentId = 'student-a',
  sourceInviteId = 'invite-a',
} = {}) {
  return createTeacherStudentRelationship({
    relationshipId,
    teacherId,
    studentId,
    displayNameOrNickname: 'Ayşe',
    active: false,
    createdAt: '2026-10-07T18:00:00.000Z',
    activatedAt: null,
    deactivatedAt: null,
    sourceInviteId,
  })
}

test('invitation repository round-trips provider-neutral records and token hash lookup', async () => {
  const { createFirestoreInvitationRepository } = await loadAdapters()
  const repository = createFirestoreInvitationRepository({ db })
  const record = invitation()

  assert.deepEqual(await repository.create(record), record)
  assert.deepEqual(await repository.getById('invite-a'), record)
  assert.deepEqual(await repository.findPendingByTeacherAndEmail('teacher-a', 'student@example.com'), record)
  assert.deepEqual(await repository.findByTokenHash('a'.repeat(64)), record)
  assert.equal(typeof (await repository.getById('invite-a')).createdAt, 'string')
})

test('concurrent invitations allow only one live PENDING record per teacher and email', async () => {
  const { createFirestoreInvitationRepository } = await loadAdapters()
  const repository = createFirestoreInvitationRepository({ db })
  const left = invitation({ inviteId: 'invite-left', tokenHash: 'b'.repeat(64) })
  const right = invitation({ inviteId: 'invite-right', tokenHash: 'c'.repeat(64) })

  const results = await Promise.allSettled([repository.create(left), repository.create(right)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  const pending = await repository.findPendingByTeacherAndEmail('teacher-a', 'student@example.com')
  assert.equal(['invite-left', 'invite-right'].includes(pending.inviteId), true)
})

test('invitation replace uses optimistic comparison and releases pending uniqueness after acceptance', async () => {
  const { createFirestoreInvitationRepository } = await loadAdapters()
  const repository = createFirestoreInvitationRepository({ db })
  const record = invitation()
  await repository.create(record)
  const accepted = acceptStudentInvitation(record, {
    studentId: 'student-a',
    acceptedAt: '2026-10-07T19:00:00.000Z',
  })

  await assert.rejects(
    repository.replace(Object.freeze({ ...record, studentDisplayNameOrNickname: 'stale' }), accepted),
    /optimistic|conflict/i,
  )
  assert.deepEqual(await repository.replace(record, accepted), accepted)

  const replacement = invitation({ inviteId: 'invite-b', tokenHash: 'd'.repeat(64) })
  assert.deepEqual(await repository.create(replacement), replacement)
  assert.equal((await repository.findPendingByTeacherAndEmail('teacher-a', 'student@example.com')).inviteId, 'invite-b')
})

test('student account repository is idempotent for exact create and unique per Firebase UID', async () => {
  const { createFirestoreStudentAccountRepository } = await loadAdapters()
  const repository = createFirestoreStudentAccountRepository({ db })
  const original = account()

  assert.deepEqual(await repository.createActivating(original), original)
  assert.deepEqual(await repository.createActivating(original), original)
  assert.deepEqual(await repository.findByFirebaseUid('firebase-uid-a'), original)

  const conflict = account({ studentId: 'student-b', firebaseUid: 'firebase-uid-a' })
  await assert.rejects(repository.createActivating(conflict), /conflict/i)
  assert.equal((await repository.findByFirebaseUid('firebase-uid-a')).studentId, 'student-a')
})

test('concurrent student account creation for one Firebase UID converges to one stable student', async () => {
  const { createFirestoreStudentAccountRepository } = await loadAdapters()
  const repository = createFirestoreStudentAccountRepository({ db })
  const results = await Promise.allSettled([
    repository.createActivating(account({ studentId: 'student-left' })),
    repository.createActivating(account({ studentId: 'student-right' })),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(['student-left', 'student-right'].includes((await repository.findByFirebaseUid('firebase-uid-a')).studentId), true)
})

test('student account markActive persists the activation transition', async () => {
  const { createFirestoreStudentAccountRepository } = await loadAdapters()
  const repository = createFirestoreStudentAccountRepository({ db })
  await repository.createActivating(account())
  const active = await repository.markActive('student-a')
  assert.equal(active.active, true)
  assert.equal((await repository.findByFirebaseUid('firebase-uid-a')).active, true)
})

test('relationship repository is unique per source invite and persists activation retry state', async () => {
  const { createFirestoreRelationshipRepository } = await loadAdapters()
  const repository = createFirestoreRelationshipRepository({ db })
  const original = relationship()

  assert.deepEqual(await repository.beginActivation(original), original)
  assert.deepEqual(await repository.beginActivation(original), original)
  assert.deepEqual(await repository.getBySourceInviteId('invite-a'), original)

  const active = await repository.markActive('relationship-a', '2026-10-07T19:00:00.000Z')
  assert.equal(active.active, true)
  assert.equal((await repository.getBySourceInviteId('invite-a')).active, true)
})

test('concurrent relationships for one source invite converge to one record', async () => {
  const { createFirestoreRelationshipRepository } = await loadAdapters()
  const repository = createFirestoreRelationshipRepository({ db })
  const results = await Promise.allSettled([
    repository.beginActivation(relationship({ relationshipId: 'relationship-left' })),
    repository.beginActivation(relationship({ relationshipId: 'relationship-right' })),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(
    ['relationship-left', 'relationship-right'].includes((await repository.getBySourceInviteId('invite-a')).relationshipId),
    true,
  )
})
