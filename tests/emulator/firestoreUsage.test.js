import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-st-student-account'
const APP_NAME = `account-usage-firestore-test-${process.pid}`
const app = initializeApp({ projectId: PROJECT_ID }, APP_NAME)
const db = getFirestore(app)

async function clearUsage() {
  const summaries = await db.collection('studentUsage').get()
  for (const summary of summaries.docs) {
    const sessions = await summary.ref.collection('sessions').get()
    const batch = db.batch()
    for (const session of sessions.docs) batch.delete(session.ref)
    batch.delete(summary.ref)
    await batch.commit()
  }
}

beforeEach(clearUsage)
after(async () => {
  await clearUsage()
  await deleteApp(app)
})

async function loadAdapter() {
  try {
    return await import('../../src/adapters/firebase/firestoreUsageRepository.js')
  } catch (error) {
    assert.fail(`Firestore usage adapter must load: ${error.message}`)
  }
}

function sessionInput({
  studentId = 'student-a',
  clientSessionId = 'boot-001',
  startedAt = '2026-10-08T00:00:00.000Z',
  expiresAt = '2026-11-07T00:00:00.000Z',
} = {}) {
  return { studentId, clientSessionId, startedAt, expiresAt }
}

test('new session creates one aggregate increment and one TTL-ready idempotency event', async () => {
  const { createFirestoreUsageRepository } = await loadAdapter()
  const repository = createFirestoreUsageRepository({ db })

  assert.deepEqual(await repository.recordSessionOnce(sessionInput()), {
    isNew: true,
    totalSessions: 1,
    lastSessionAt: '2026-10-08T00:00:00.000Z',
  })

  const summary = await db.collection('studentUsage').doc('student-a').get()
  assert.equal(summary.get('studentId'), 'student-a')
  assert.equal(summary.get('totalSessions'), 1)
  assert.equal(summary.get('lastSessionAt').toDate().toISOString(), '2026-10-08T00:00:00.000Z')

  const event = await summary.ref.collection('sessions').doc('boot-001').get()
  assert.equal(event.exists, true)
  assert.equal(event.get('clientSessionId'), 'boot-001')
  assert.equal(event.get('startedAt').toDate().toISOString(), '2026-10-08T00:00:00.000Z')
  assert.equal(event.get('expiresAt').toDate().toISOString(), '2026-11-07T00:00:00.000Z')
})

test('duplicate session ID returns existing acknowledgement without incrementing or moving lastSessionAt', async () => {
  const { createFirestoreUsageRepository } = await loadAdapter()
  const repository = createFirestoreUsageRepository({ db })
  await repository.recordSessionOnce(sessionInput())

  const duplicate = await repository.recordSessionOnce(sessionInput({
    startedAt: '2026-10-08T00:10:00.000Z',
    expiresAt: '2026-11-07T00:10:00.000Z',
  }))

  assert.deepEqual(duplicate, {
    isNew: false,
    totalSessions: 1,
    lastSessionAt: '2026-10-08T00:00:00.000Z',
  })
  const summary = await db.collection('studentUsage').doc('student-a').get()
  assert.equal(summary.get('totalSessions'), 1)
  assert.equal(summary.get('lastSessionAt').toDate().toISOString(), '2026-10-08T00:00:00.000Z')
  const event = await summary.ref.collection('sessions').doc('boot-001').get()
  assert.equal(event.get('startedAt').toDate().toISOString(), '2026-10-08T00:00:00.000Z')
})

test('concurrent duplicate submissions increment totalSessions at most once', async () => {
  const { createFirestoreUsageRepository } = await loadAdapter()
  const repository = createFirestoreUsageRepository({ db })

  const results = await Promise.all(
    Array.from({ length: 8 }, () => repository.recordSessionOnce(sessionInput({ clientSessionId: 'boot-concurrent' }))),
  )

  assert.equal(results.filter((result) => result.isNew).length, 1)
  assert.equal(results.every((result) => result.totalSessions === 1), true)
  const summary = await db.collection('studentUsage').doc('student-a').get()
  assert.equal(summary.get('totalSessions'), 1)
  const sessions = await summary.ref.collection('sessions').get()
  assert.equal(sessions.size, 1)
})

test('different session IDs increment independently even when submitted concurrently', async () => {
  const { createFirestoreUsageRepository } = await loadAdapter()
  const repository = createFirestoreUsageRepository({ db })

  const results = await Promise.all([
    repository.recordSessionOnce(sessionInput({ clientSessionId: 'boot-left' })),
    repository.recordSessionOnce(sessionInput({ clientSessionId: 'boot-right' })),
  ])

  assert.equal(results.every((result) => result.isNew), true)
  const summary = await db.collection('studentUsage').doc('student-a').get()
  assert.equal(summary.get('totalSessions'), 2)
  const sessions = await summary.ref.collection('sessions').get()
  assert.equal(sessions.size, 2)
})
