import assert from 'node:assert/strict'
import test from 'node:test'

async function loadService() {
  try {
    return await import('../../src/application/listTeacherStudents.js')
  } catch (error) {
    assert.fail(`listTeacherStudents service must load: ${error.message}`)
  }
}

function invitation(overrides = {}) {
  return Object.freeze({
    inviteId: 'invite-a', teacherId: 'teacher-a', emailNormalized: 'student@example.com',
    studentDisplayNameOrNickname: 'Ayşe', status: 'PENDING', tokenHash: 'a'.repeat(64),
    createdAt: '2026-10-07T18:00:00.000Z', expiresAt: '2026-10-14T18:00:00.000Z',
    acceptedAt: null, revokedAt: null, studentId: null, ...overrides,
  })
}

function relationship(overrides = {}) {
  return Object.freeze({
    relationshipId: 'relationship-a', teacherId: 'teacher-a', studentId: 'student-a',
    displayNameOrNickname: 'Ayşe', active: false, createdAt: '2026-10-07T18:10:00.000Z',
    activatedAt: null, deactivatedAt: null, sourceInviteId: 'invite-a', ...overrides,
  })
}

function account(overrides = {}) {
  return Object.freeze({
    studentId: 'student-a', firebaseUid: 'firebase-secret-a', emailNormalized: 'student@example.com',
    active: false, createdAt: '2026-10-07T18:10:00.000Z', ...overrides,
  })
}

function harness({ invitations, relationships = [], accounts = [], usage = [], presence } = {}) {
  const relationshipByInvite = new Map(relationships.map((item) => [item.sourceInviteId, item]))
  const accountByStudent = new Map(accounts.map((item) => [item.studentId, item]))
  const usageByStudent = new Map(usage.map((item) => [item.studentId, item]))
  const presenceCalls = []
  return {
    presenceCalls,
    dependencies: {
      invitationRepository: {
        async listByTeacherId(teacherId) { return (invitations ?? []).filter((item) => item.teacherId === teacherId) },
      },
      relationshipRepository: {
        async getBySourceInviteId(inviteId) { return relationshipByInvite.get(inviteId) ?? null },
      },
      studentAccountRepository: {
        async getByStudentId(studentId) { return accountByStudent.get(studentId) ?? null },
      },
      usageRepository: {
        async getSummary(studentId) { return usageByStudent.get(studentId) ?? null },
      },
      presenceReader: {
        async getPresenceByFirebaseUid(firebaseUid) {
          presenceCalls.push(firebaseUid)
          if (presence instanceof Error) throw presence
          if (typeof presence === 'function') return presence(firebaseUid)
          return presence ?? { state: 'OFFLINE', lastOnlineAt: null }
        },
      },
    },
  }
}

test('pending invite is INVITED before account exists and defaults usage/presence safely', async () => {
  const { listTeacherStudentsService } = await loadService()
  const fixture = harness({ invitations: [invitation()] })
  const service = listTeacherStudentsService(fixture.dependencies)
  assert.deepEqual(await service.execute({ teacherId: 'teacher-a' }), [{
    managementId: 'invite-a', studentId: null, displayNameOrNickname: 'Ayşe', state: 'INVITED',
    invitationStatus: 'PENDING', presenceState: 'UNKNOWN', lastOnlineAt: null,
    lastSessionAt: null, totalSessions: 0,
  }])
  assert.equal(fixture.presenceCalls.length, 0)
})

test('ACTIVATING never becomes ACTIVE before relationship and account are both active', async () => {
  const { listTeacherStudentsService } = await loadService()
  const accepted = invitation({ status: 'ACCEPTED', studentId: 'student-a', acceptedAt: '2026-10-07T18:20:00.000Z' })
  const fixture = harness({ invitations: [accepted], relationships: [relationship()], accounts: [account()] })
  const [row] = await listTeacherStudentsService(fixture.dependencies).execute({ teacherId: 'teacher-a' })
  assert.equal(row.state, 'ACTIVATING')
})

test('ACTIVE row joins usage and presence without leaking UID/email/token', async () => {
  const { listTeacherStudentsService } = await loadService()
  const accepted = invitation({ status: 'ACCEPTED', studentId: 'student-a', acceptedAt: '2026-10-07T18:20:00.000Z' })
  const fixture = harness({
    invitations: [accepted],
    relationships: [relationship({ active: true, activatedAt: '2026-10-07T18:21:00.000Z' })],
    accounts: [account({ active: true })],
    usage: [{ studentId: 'student-a', totalSessions: 7, lastSessionAt: '2026-10-08T00:00:00.000Z' }],
    presence: { state: 'ONLINE', lastOnlineAt: '2026-10-08T00:10:00.000Z' },
  })
  const [row] = await listTeacherStudentsService(fixture.dependencies).execute({ teacherId: 'teacher-a' })
  assert.deepEqual(row, {
    managementId: 'invite-a', studentId: 'student-a', displayNameOrNickname: 'Ayşe', state: 'ACTIVE',
    invitationStatus: 'ACCEPTED', presenceState: 'ONLINE', lastOnlineAt: '2026-10-08T00:10:00.000Z',
    lastSessionAt: '2026-10-08T00:00:00.000Z', totalSessions: 7,
  })
  const serialized = JSON.stringify(row)
  assert.equal(serialized.includes('firebase-secret-a'), false)
  assert.equal(serialized.includes('student@example.com'), false)
  assert.equal(serialized.includes('a'.repeat(64)), false)
})

test('INACTIVE preserves usage history but does not expose live presence', async () => {
  const { listTeacherStudentsService } = await loadService()
  const accepted = invitation({ status: 'ACCEPTED', studentId: 'student-a', acceptedAt: '2026-10-07T18:20:00.000Z' })
  const fixture = harness({
    invitations: [accepted], relationships: [relationship({ deactivatedAt: '2026-10-08T01:00:00.000Z' })],
    accounts: [account({ active: true })],
    usage: [{ studentId: 'student-a', totalSessions: 4, lastSessionAt: '2026-10-08T00:30:00.000Z' }],
    presence: { state: 'ONLINE', lastOnlineAt: '2026-10-08T00:40:00.000Z' },
  })
  const [row] = await listTeacherStudentsService(fixture.dependencies).execute({ teacherId: 'teacher-a' })
  assert.equal(row.state, 'INACTIVE')
  assert.equal(row.totalSessions, 4)
  assert.equal(row.presenceState, 'UNKNOWN')
  assert.equal(fixture.presenceCalls.length, 0)
})

test('presence failure becomes UNKNOWN without failing the list', async () => {
  const { listTeacherStudentsService } = await loadService()
  const accepted = invitation({ status: 'ACCEPTED', studentId: 'student-a', acceptedAt: '2026-10-07T18:20:00.000Z' })
  const fixture = harness({
    invitations: [accepted], relationships: [relationship({ active: true, activatedAt: '2026-10-07T18:21:00.000Z' })],
    accounts: [account({ active: true })], presence: new Error('database-unavailable'),
  })
  const [row] = await listTeacherStudentsService(fixture.dependencies).execute({ teacherId: 'teacher-a' })
  assert.equal(row.state, 'ACTIVE')
  assert.equal(row.presenceState, 'UNKNOWN')
  assert.equal(row.lastOnlineAt, null)
})

test('foreign teacher rows are isolated and output ordering is deterministic', async () => {
  const { listTeacherStudentsService } = await loadService()
  const fixture = harness({ invitations: [
    invitation({ inviteId: 'invite-z', createdAt: '2026-10-07T20:00:00.000Z' }),
    invitation({ inviteId: 'invite-foreign', teacherId: 'teacher-b' }),
    invitation({ inviteId: 'invite-a', createdAt: '2026-10-07T18:00:00.000Z' }),
  ] })
  const rows = await listTeacherStudentsService(fixture.dependencies).execute({ teacherId: 'teacher-a' })
  assert.deepEqual(rows.map((row) => row.managementId), ['invite-a', 'invite-z'])
  assert.equal(JSON.stringify(rows).includes('invite-foreign'), false)
})

test('relationship teacher mismatch fails closed', async () => {
  const { listTeacherStudentsService } = await loadService()
  const accepted = invitation({ status: 'ACCEPTED', studentId: 'student-a', acceptedAt: '2026-10-07T18:20:00.000Z' })
  const fixture = harness({ invitations: [accepted], relationships: [relationship({ teacherId: 'teacher-b' })] })
  const service = listTeacherStudentsService(fixture.dependencies)
  await assert.rejects(() => service.execute({ teacherId: 'teacher-a' }), /conflict/i)
})
