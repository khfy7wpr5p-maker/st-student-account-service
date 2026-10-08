import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { createStudentInvitation } from '../../src/domain/studentInvitation.js'
import { createStudentAccount } from '../../src/domain/studentAccount.js'

const PROJECT_ID = 'demo-st-student-account'
const APP_NAME = `account-read-model-firestore-test-${process.pid}`
const app = initializeApp({ projectId: PROJECT_ID }, APP_NAME)
const db = getFirestore(app)

const COLLECTIONS = [
  'studentInvitations', 'studentInvitationPendingLocks', 'studentAccounts',
  'studentAccountUidMappings', 'studentUsage',
]

async function clearData() {
  const usage = await db.collection('studentUsage').get()
  for (const summary of usage.docs) {
    const sessions = await summary.ref.collection('sessions').get()
    const batch = db.batch()
    for (const session of sessions.docs) batch.delete(session.ref)
    batch.delete(summary.ref)
    await batch.commit()
  }
  for (const name of COLLECTIONS.filter((value) => value !== 'studentUsage')) {
    const snapshot = await db.collection(name).get()
    if (snapshot.empty) continue
    const batch = db.batch()
    for (const document of snapshot.docs) batch.delete(document.ref)
    await batch.commit()
  }
}

beforeEach(clearData)
after(async () => {
  await clearData()
  await deleteApp(app)
})

function invitation({ inviteId, teacherId, email, tokenHash }) {
  return createStudentInvitation({
    inviteId,
    teacherId,
    email,
    studentDisplayNameOrNickname: inviteId,
    tokenHash,
    createdAt: '2026-10-07T18:00:00.000Z',
  })
}

test('invitation repository lists only one teacher scope', async () => {
  const { createFirestoreInvitationRepository } = await import('../../src/adapters/firebase/firestoreInvitationRepository.js')
  const repository = createFirestoreInvitationRepository({ db })
  await repository.create(invitation({ inviteId: 'invite-a', teacherId: 'teacher-a', email: 'a@example.com', tokenHash: 'a'.repeat(64) }))
  await repository.create(invitation({ inviteId: 'invite-b', teacherId: 'teacher-b', email: 'b@example.com', tokenHash: 'b'.repeat(64) }))

  assert.deepEqual((await repository.listByTeacherId('teacher-a')).map((item) => item.inviteId), ['invite-a'])
})

test('student account repository reads by stable studentId', async () => {
  const { createFirestoreStudentAccountRepository } = await import('../../src/adapters/firebase/firestoreStudentAccountRepository.js')
  const repository = createFirestoreStudentAccountRepository({ db })
  const record = createStudentAccount({
    studentId: 'student-a',
    firebaseUid: 'firebase-a',
    email: 'a@example.com',
    createdAt: '2026-10-07T18:00:00.000Z',
    active: true,
  })
  await repository.createActivating(record)

  assert.deepEqual(await repository.getByStudentId('student-a'), record)
})

test('usage repository reads provider-neutral summary by stable studentId', async () => {
  const { createFirestoreUsageRepository } = await import('../../src/adapters/firebase/firestoreUsageRepository.js')
  const repository = createFirestoreUsageRepository({ db })
  await repository.recordSessionOnce({
    studentId: 'student-a',
    clientSessionId: 'boot-001',
    startedAt: '2026-10-08T00:00:00.000Z',
    expiresAt: '2026-11-07T00:00:00.000Z',
  })

  assert.deepEqual(await repository.getSummary('student-a'), {
    schemaVersion: 1,
    studentId: 'student-a',
    totalSessions: 1,
    lastSessionAt: '2026-10-08T00:00:00.000Z',
  })
})
