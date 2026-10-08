import assert from 'node:assert/strict'
import test from 'node:test'

import { acceptStudentInvitation, createStudentInvitation, expireStudentInvitation, revokeStudentInvitation } from '../../src/domain/studentInvitation.js'
import { createStudentAccount } from '../../src/domain/studentAccount.js'
import { createInMemoryInvitationRepository } from '../helpers/inMemoryInvitationRepository.js'
import { createInMemoryRelationshipRepository } from '../helpers/inMemoryRelationshipRepository.js'
import { createInMemoryStudentAccountRepository } from '../helpers/inMemoryStudentAccountRepository.js'
import { createFakeSecureDeliveryAuthorityPort } from '../helpers/fakeSecureDeliveryAuthorityPort.js'

async function loadActivation() {
  try {
    return await import('../../src/application/acceptInvitation.js')
  } catch (error) {
    assert.fail(`accept invitation module must load: ${error.message}`)
  }
}

const CREATED_AT = '2026-10-07T18:00:00.000Z'
const TOKEN_HASH = 'a'.repeat(64)

function invitation(overrides = {}) {
  return createStudentInvitation({
    inviteId: 'invite-a',
    teacherId: 'teacher-a',
    email: 'student@example.com',
    studentDisplayNameOrNickname: 'Ayşe',
    tokenHash: TOKEN_HASH,
    createdAt: CREATED_AT,
    ...overrides,
  })
}

function clock(value = '2026-10-07T19:00:00.000Z') {
  return { now: () => value }
}

function tokenGenerator() {
  const counts = new Map()
  return {
    createInviteToken() { return 'unused' },
    hashInviteToken() { return TOKEN_HASH },
    createDomainId(prefix) {
      const next = (counts.get(prefix) ?? 0) + 1
      counts.set(prefix, next)
      return `${prefix}-${next}`
    },
  }
}

async function serviceFor({
  invitationRecord = invitation(),
  invitationRepository,
  studentAccounts = [],
  studentAccountRepository,
  relationshipRepository,
  authority,
  now,
} = {}) {
  const { acceptInvitationService } = await loadActivation()
  const invitations = invitationRepository ?? createInMemoryInvitationRepository([invitationRecord])
  const accounts = studentAccountRepository ?? createInMemoryStudentAccountRepository(studentAccounts)
  const relationships = relationshipRepository ?? createInMemoryRelationshipRepository()
  const secureAuthority = authority ?? createFakeSecureDeliveryAuthorityPort()
  const service = acceptInvitationService({
    invitationRepository: invitations,
    studentAccountRepository: accounts,
    relationshipRepository: relationships,
    secureDeliveryAuthorityPort: secureAuthority,
    clock: clock(now),
    tokenGenerator: tokenGenerator(),
  })
  return { service, invitations, accounts, relationships, authority: secureAuthority }
}

const authenticatedUser = Object.freeze({ uid: 'firebase-student-a', email: 'student@example.com' })

test('first acceptance creates one stable student, activates authority, relationship, account, and invitation', async () => {
  const system = await serviceFor()
  const result = await system.service.execute({ rawToken: 'raw-token', authenticatedUser })

  assert.equal(result.relationshipState, 'ACTIVE')
  assert.equal(result.studentId, 'student-1')
  assert.equal(result.invitation.status, 'ACCEPTED')
  assert.equal(system.authority.calls.length, 1)
  assert.deepEqual(system.authority.calls[0], {
    firebaseUid: 'firebase-student-a',
    teacherId: 'teacher-a',
    studentId: 'student-1',
    displayNameOrNickname: 'Ayşe',
    activatedAt: '2026-10-07T19:00:00.000Z',
    sourceInviteId: 'invite-a',
  })
  assert.equal(system.accounts.snapshot().length, 1)
  assert.equal(system.accounts.snapshot()[0].active, true)
  assert.equal(system.relationships.snapshot().length, 1)
  assert.equal(system.relationships.snapshot()[0].active, true)
  assert.equal((await system.invitations.getById('invite-a')).status, 'ACCEPTED')
})

test('authenticated email mismatch fails before consuming invitation or creating local identity', async () => {
  const system = await serviceFor()
  await assert.rejects(
    system.service.execute({ rawToken: 'raw-token', authenticatedUser: { uid: 'firebase-student-a', email: 'other@example.com' } }),
    /email|identity|mismatch/i,
  )
  assert.equal((await system.invitations.getById('invite-a')).status, 'PENDING')
  assert.equal(system.accounts.snapshot().length, 0)
  assert.equal(system.relationships.snapshot().length, 0)
  assert.equal(system.authority.calls.length, 0)
})

test('conflicting existing Firebase UID identity fails closed without consuming invitation', async () => {
  const existing = createStudentAccount({
    studentId: 'student-existing',
    firebaseUid: 'firebase-student-a',
    email: 'different@example.com',
    createdAt: CREATED_AT,
    active: true,
  })
  const system = await serviceFor({ studentAccounts: [existing] })
  await assert.rejects(system.service.execute({ rawToken: 'raw-token', authenticatedUser }), /conflict|identity|email/i)
  assert.equal((await system.invitations.getById('invite-a')).status, 'PENDING')
  assert.equal(system.relationships.snapshot().length, 0)
  assert.equal(system.authority.calls.length, 0)
})

test('existing student account is reused for a second teacher invitation', async () => {
  const existing = createStudentAccount({
    studentId: 'student-existing',
    firebaseUid: 'firebase-student-a',
    email: 'student@example.com',
    createdAt: CREATED_AT,
    active: true,
  })
  const system = await serviceFor({
    invitationRecord: invitation({ inviteId: 'invite-b', teacherId: 'teacher-b' }),
    studentAccounts: [existing],
  })
  const result = await system.service.execute({ rawToken: 'raw-token', authenticatedUser })
  assert.equal(result.studentId, 'student-existing')
  assert.equal(system.accounts.snapshot().length, 1)
  assert.equal(system.relationships.snapshot()[0].teacherId, 'teacher-b')
})

test('accepted, revoked, and expired invitations cannot start activation', async () => {
  const pending = invitation()
  const records = [
    acceptStudentInvitation(pending, { studentId: 'student-x', acceptedAt: '2026-10-07T19:00:00.000Z' }),
    revokeStudentInvitation(invitation({ inviteId: 'invite-r' }), '2026-10-07T19:00:00.000Z'),
    expireStudentInvitation(invitation({ inviteId: 'invite-e' }), '2026-10-14T18:00:00.000Z'),
  ]
  for (const record of records) {
    const system = await serviceFor({ invitationRecord: record })
    await assert.rejects(system.service.execute({ rawToken: 'raw-token', authenticatedUser }), /pending|unavailable|expired|accepted|revoked/i)
    assert.equal(system.authority.calls.length, 0)
  }
})

test('authority acknowledgement mismatch leaves account and relationship non-active and invitation pending', async () => {
  const authority = createFakeSecureDeliveryAuthorityPort({
    handler: async (input) => ({ studentId: input.studentId, teacherId: input.teacherId, identityActive: true, grantActive: false }),
  })
  const system = await serviceFor({ authority })
  await assert.rejects(system.service.execute({ rawToken: 'raw-token', authenticatedUser }), /authority|ack/i)
  assert.equal(system.accounts.snapshot()[0].active, false)
  assert.equal(system.relationships.snapshot()[0].active, false)
  assert.equal((await system.invitations.getById('invite-a')).status, 'PENDING')
})

test('authority failure is retry-safe and reuses the same student and relationship ids', async () => {
  const authority = createFakeSecureDeliveryAuthorityPort({ failuresRemaining: 1 })
  const system = await serviceFor({ authority })
  await assert.rejects(system.service.execute({ rawToken: 'raw-token', authenticatedUser }), /authority/i)
  const stagedStudentId = system.accounts.snapshot()[0].studentId
  const stagedRelationshipId = system.relationships.snapshot()[0].relationshipId
  assert.equal(system.accounts.snapshot()[0].active, false)
  assert.equal(system.relationships.snapshot()[0].active, false)

  const result = await system.service.execute({ rawToken: 'raw-token', authenticatedUser })
  assert.equal(result.studentId, stagedStudentId)
  assert.equal(system.relationships.snapshot()[0].relationshipId, stagedRelationshipId)
  assert.equal(system.accounts.snapshot().length, 1)
  assert.equal(system.relationships.snapshot().length, 1)
  assert.equal(authority.calls.length, 2)
})

test('local invitation-finalize failure after authority success converges safely on retry without repeating authority', async () => {
  const base = createInMemoryInvitationRepository([invitation()])
  let failAcceptance = true
  const invitationRepository = Object.freeze({
    ...base,
    async replace(expected, next) {
      if (next.status === 'ACCEPTED' && failAcceptance) {
        failAcceptance = false
        throw new Error('local-finalize-failure')
      }
      return base.replace(expected, next)
    },
  })
  const authority = createFakeSecureDeliveryAuthorityPort()
  const system = await serviceFor({ invitationRepository, authority })

  await assert.rejects(system.service.execute({ rawToken: 'raw-token', authenticatedUser }), /local-finalize/i)
  assert.equal((await base.getById('invite-a')).status, 'PENDING')
  assert.equal(system.relationships.snapshot()[0].active, true)

  const result = await system.service.execute({ rawToken: 'raw-token', authenticatedUser })
  assert.equal(result.relationshipState, 'ACTIVE')
  assert.equal((await base.getById('invite-a')).status, 'ACCEPTED')
  assert.equal(authority.calls.length, 1)
})

test('concurrent duplicate acceptance converges to one student and one relationship', async () => {
  const system = await serviceFor()
  const [left, right] = await Promise.all([
    system.service.execute({ rawToken: 'raw-token', authenticatedUser }),
    system.service.execute({ rawToken: 'raw-token', authenticatedUser }),
  ])
  assert.equal(left.studentId, right.studentId)
  assert.equal(system.accounts.snapshot().length, 1)
  assert.equal(system.relationships.snapshot().length, 1)
  assert.equal(system.authority.calls.length, 1)
  assert.equal((await system.invitations.getById('invite-a')).status, 'ACCEPTED')
})
