import assert from 'node:assert/strict'
import test from 'node:test'

import { backfillSecureDeliveryRoster } from '../../src/maintenance/backfillSecureDeliveryRoster.js'
import { runSecureDeliveryRosterBackfill } from '../../src/maintenance/runSecureDeliveryRosterBackfill.js'

function relationship(overrides = {}) {
  return Object.freeze({
    relationshipId: 'relationship-a',
    teacherId: 'teacher-a',
    studentId: 'student-a',
    displayNameOrNickname: 'Ayşe',
    active: true,
    createdAt: '2026-10-08T20:00:00.000Z',
    activatedAt: '2026-10-08T20:05:00.000Z',
    deactivatedAt: null,
    sourceInviteId: 'invite-a',
    ...overrides,
  })
}

function account(overrides = {}) {
  return Object.freeze({
    studentId: 'student-a',
    firebaseUid: 'firebase-student-a',
    emailNormalized: 'student@example.com',
    createdAt: '2026-10-08T20:00:00.000Z',
    active: true,
    ...overrides,
  })
}

test('backfill repairs only missing roster projections with canonical relationship data', async () => {
  const activationCalls = []
  const result = await backfillSecureDeliveryRoster({
    listActiveRelationships: async () => [relationship()],
    getStudentAccount: async () => account(),
    hasRosterEntry: async () => false,
    activateStudent: async (input) => {
      activationCalls.push(Object.freeze({ ...input }))
      return Object.freeze({
        studentId: input.studentId,
        teacherId: input.teacherId,
        identityActive: true,
        grantActive: true,
      })
    },
  })

  assert.deepEqual(result, { scanned: 1, repaired: 1, skipped: 0 })
  assert.deepEqual(activationCalls, [
    {
      firebaseUid: 'firebase-student-a',
      teacherId: 'teacher-a',
      studentId: 'student-a',
      displayNameOrNickname: 'Ayşe',
      activatedAt: '2026-10-08T20:05:00.000Z',
      sourceInviteId: 'invite-a',
    },
  ])
})

test('backfill skips relationships whose roster projection already exists', async () => {
  let accountReads = 0
  let activationCalls = 0
  const result = await backfillSecureDeliveryRoster({
    listActiveRelationships: async () => [relationship()],
    getStudentAccount: async () => {
      accountReads += 1
      return account()
    },
    hasRosterEntry: async () => true,
    activateStudent: async () => {
      activationCalls += 1
    },
  })

  assert.deepEqual(result, { scanned: 1, repaired: 0, skipped: 1 })
  assert.equal(accountReads, 0)
  assert.equal(activationCalls, 0)
})

test('backfill fails closed when an active relationship has no matching active student account', async () => {
  let activationCalls = 0
  await assert.rejects(
    () => backfillSecureDeliveryRoster({
      listActiveRelationships: async () => [relationship()],
      getStudentAccount: async () => account({ active: false }),
      hasRosterEntry: async () => false,
      activateStudent: async () => {
        activationCalls += 1
      },
    }),
    /backfill-student-account-unavailable/,
  )
  assert.equal(activationCalls, 0)
})

test('production backfill runner is a strict no-op unless the explicit flag equals 1', async () => {
  let adminAccessCalls = 0
  const result = await runSecureDeliveryRosterBackfill({
    env: {
      ACCOUNT_SERVICE_SECURE_DELIVERY_ROSTER_BACKFILL: '0',
    },
    createAdminAccess() {
      adminAccessCalls += 1
      throw new Error('must-not-open-admin-access')
    },
  })

  assert.deepEqual(result, {
    enabled: false,
    scanned: 0,
    repaired: 0,
    skipped: 0,
  })
  assert.equal(adminAccessCalls, 0)
})
