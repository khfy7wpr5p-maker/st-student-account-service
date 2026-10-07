import assert from 'node:assert/strict'
import test from 'node:test'

async function loadDomain() {
  try {
    const [invitation, account, relationship, usage, clock, tokenGenerator] = await Promise.all([
      import('../../src/domain/studentInvitation.js'),
      import('../../src/domain/studentAccount.js'),
      import('../../src/domain/teacherStudentRelationship.js'),
      import('../../src/domain/studentUsage.js'),
      import('../../src/ports/clock.js'),
      import('../../src/ports/tokenGenerator.js'),
    ])
    return { invitation, account, relationship, usage, clock, tokenGenerator }
  } catch (error) {
    assert.fail(`domain modules must load: ${error.message}`)
  }
}

test('StudentInvitation v1 is strict, immutable, normalized, and expires in seven days', async () => {
  const { invitation } = await loadDomain()
  const row = invitation.createStudentInvitation({
    inviteId: 'invite-a',
    teacherId: 'teacher-a',
    email: '  Student@Example.COM ',
    studentDisplayNameOrNickname: 'Ayşe',
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-10-07T18:00:00.000Z',
  })

  assert.equal(row.schemaVersion, 1)
  assert.equal(row.emailNormalized, 'student@example.com')
  assert.equal(row.status, 'PENDING')
  assert.equal(row.expiresAt, '2026-10-14T18:00:00.000Z')
  assert.equal(row.acceptedAt, null)
  assert.equal(row.revokedAt, null)
  assert.equal(row.studentId, null)
  assert.equal(Object.isFrozen(row), true)
  assert.equal('password' in row, false)
  assert.equal('firebaseUid' in row, false)

  assert.throws(
    () => invitation.createStudentInvitation({
      inviteId: 'invite-b',
      teacherId: 'teacher-a',
      email: 'student@example.com',
      studentDisplayNameOrNickname: 'Ayşe',
      tokenHash: 'b'.repeat(64),
      createdAt: '2026-10-07T18:00:00.000Z',
      extra: true,
    }),
    /unsupported|unknown|field/i,
  )
})

test('StudentInvitation transitions are one-way', async () => {
  const { invitation } = await loadDomain()
  const pending = invitation.createStudentInvitation({
    inviteId: 'invite-a',
    teacherId: 'teacher-a',
    email: 'student@example.com',
    studentDisplayNameOrNickname: 'Ayşe',
    tokenHash: 'c'.repeat(64),
    createdAt: '2026-10-07T18:00:00.000Z',
  })

  const accepted = invitation.acceptStudentInvitation(pending, {
    studentId: 'student-a',
    acceptedAt: '2026-10-07T19:00:00.000Z',
  })
  assert.equal(accepted.status, 'ACCEPTED')
  assert.equal(accepted.studentId, 'student-a')
  assert.equal(accepted.acceptedAt, '2026-10-07T19:00:00.000Z')
  assert.throws(() => invitation.revokeStudentInvitation(accepted, '2026-10-07T20:00:00.000Z'), /PENDING/i)

  const revoked = invitation.revokeStudentInvitation(pending, '2026-10-07T20:00:00.000Z')
  assert.equal(revoked.status, 'REVOKED')
  assert.equal(revoked.revokedAt, '2026-10-07T20:00:00.000Z')
  assert.throws(() => invitation.acceptStudentInvitation(revoked, { studentId: 'student-a', acceptedAt: '2026-10-07T21:00:00.000Z' }), /PENDING/i)

  const expired = invitation.expireStudentInvitation(pending, '2026-10-14T18:00:00.000Z')
  assert.equal(expired.status, 'EXPIRED')
  assert.throws(() => invitation.acceptStudentInvitation(expired, { studentId: 'student-a', acceptedAt: '2026-10-14T18:00:00.000Z' }), /PENDING/i)
})

test('StudentAccount v1 keeps provider identity server-private and stable', async () => {
  const { account } = await loadDomain()
  const row = account.createStudentAccount({
    studentId: 'student-a',
    firebaseUid: 'firebase-uid-a',
    email: ' Student@Example.COM ',
    createdAt: '2026-10-07T18:00:00.000Z',
    active: false,
  })

  assert.equal(row.schemaVersion, 1)
  assert.equal(row.studentId, 'student-a')
  assert.equal(row.firebaseUid, 'firebase-uid-a')
  assert.equal(row.emailNormalized, 'student@example.com')
  assert.equal(row.active, false)
  assert.equal(Object.isFrozen(row), true)
  assert.equal('password' in row, false)
})

test('TeacherStudentRelationship activates and deactivates without changing stable ids', async () => {
  const { relationship } = await loadDomain()
  const staging = relationship.createTeacherStudentRelationship({
    relationshipId: 'rel-a',
    teacherId: 'teacher-a',
    studentId: 'student-a',
    displayNameOrNickname: 'Ayşe',
    active: false,
    createdAt: '2026-10-07T18:00:00.000Z',
    activatedAt: null,
    deactivatedAt: null,
    sourceInviteId: 'invite-a',
  })

  const active = relationship.activateTeacherStudentRelationship(staging, '2026-10-07T19:00:00.000Z')
  assert.equal(active.active, true)
  assert.equal(active.activatedAt, '2026-10-07T19:00:00.000Z')
  assert.equal(active.studentId, 'student-a')

  const inactive = relationship.deactivateTeacherStudentRelationship(active, '2026-10-08T09:00:00.000Z')
  assert.equal(inactive.active, false)
  assert.equal(inactive.deactivatedAt, '2026-10-08T09:00:00.000Z')
  assert.equal(inactive.studentId, 'student-a')
})

test('StudentUsage records are immutable and counters cannot be negative', async () => {
  const { usage } = await loadDomain()
  const summary = usage.createStudentUsageSummary({
    studentId: 'student-a',
    totalSessions: 0,
    lastSessionAt: null,
  })
  const session = usage.createStudentUsageSession({
    studentId: 'student-a',
    clientSessionId: 'session-a',
    startedAt: '2026-10-07T18:00:00.000Z',
    expiresAt: '2026-11-06T18:00:00.000Z',
  })

  assert.equal(summary.totalSessions, 0)
  assert.equal(Object.isFrozen(summary), true)
  assert.equal(Object.isFrozen(session), true)
  assert.throws(() => usage.createStudentUsageSummary({ studentId: 'student-a', totalSessions: -1, lastSessionAt: null }), /non-negative/i)
})

test('Clock and token generator ports reject incomplete adapters', async () => {
  const { clock, tokenGenerator } = await loadDomain()
  assert.equal(clock.assertClock({ now: () => '2026-10-07T18:00:00.000Z' }).now(), '2026-10-07T18:00:00.000Z')
  assert.throws(() => clock.assertClock({}), /now/i)

  const generator = {
    createInviteToken: () => 'raw',
    hashInviteToken: () => 'f'.repeat(64),
    createDomainId: (prefix) => `${prefix}-a`,
  }
  assert.equal(tokenGenerator.assertTokenGenerator(generator), generator)
  assert.throws(() => tokenGenerator.assertTokenGenerator({ createInviteToken() {} }), /hashInviteToken|createDomainId/i)
})
