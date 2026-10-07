import assert from 'node:assert/strict'
import test from 'node:test'

import { createStudentInvitation, acceptStudentInvitation, revokeStudentInvitation } from '../../src/domain/studentInvitation.js'
import { createInMemoryInvitationRepository } from '../helpers/inMemoryInvitationRepository.js'

async function loadServices() {
  try {
    const [createModule, resolveModule, revokeModule] = await Promise.all([
      import('../../src/application/createInvitation.js'),
      import('../../src/application/resolveInvitation.js'),
      import('../../src/application/revokeInvitation.js'),
    ])
    return { ...createModule, ...resolveModule, ...revokeModule }
  } catch (error) {
    assert.fail(`invitation application modules must load: ${error.message}`)
  }
}

function createClock(initial = '2026-10-07T18:00:00.000Z') {
  let now = initial
  return {
    now: () => now,
    set: (next) => { now = next },
  }
}

function createTokenGenerator() {
  let inviteSequence = 0
  let tokenSequence = 0
  return {
    createInviteToken() {
      tokenSequence += 1
      return `raw-secret-${tokenSequence}`
    },
    hashInviteToken(rawToken) {
      return rawToken === 'shared-token'
        ? 'f'.repeat(64)
        : String(tokenSequence).padStart(64, '0')
    },
    createDomainId(prefix) {
      inviteSequence += 1
      return `${prefix}-${inviteSequence}`
    },
  }
}

function authDirectory(existingEmails = []) {
  const emails = new Set(existingEmails)
  return {
    async accountExistsByEmail(emailNormalized) {
      return emails.has(emailNormalized)
    },
  }
}

test('create invitation normalizes email, returns one link, and persists no raw token', async () => {
  const { createInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const service = createInvitationService({
    repository,
    clock: createClock(),
    tokenGenerator: createTokenGenerator(),
    invitationBaseUrl: 'https://student.example',
  })

  const result = await service.execute({
    teacherId: 'teacher-a',
    email: ' Student@Example.COM ',
    displayNameOrNickname: 'Ayşe',
  })

  assert.equal(result.invitation.emailNormalized, 'student@example.com')
  assert.equal(result.invitation.status, 'PENDING')
  assert.equal(result.invitation.expiresAt, '2026-10-14T18:00:00.000Z')
  assert.equal(result.invitationLink, 'https://student.example/#/invite/raw-secret-1')
  assert.equal(repository.snapshot().length, 1)
  assert.equal(JSON.stringify(repository.snapshot()).includes('raw-secret-1'), false)
})

test('one live pending invitation per teacher and normalized email', async () => {
  const { createInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const clock = createClock()
  const service = createInvitationService({ repository, clock, tokenGenerator: createTokenGenerator(), invitationBaseUrl: 'https://student.example' })

  await service.execute({ teacherId: 'teacher-a', email: 'student@example.com', displayNameOrNickname: 'Ayşe' })

  await assert.rejects(
    service.execute({ teacherId: 'teacher-a', email: ' STUDENT@example.com ', displayNameOrNickname: 'Ayşe 2' }),
    /pending|conflict/i,
  )

  assert.equal(repository.snapshot().length, 1)
})

test('expired pending invitation is expired before a replacement is created', async () => {
  const { createInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const clock = createClock()
  const service = createInvitationService({ repository, clock, tokenGenerator: createTokenGenerator(), invitationBaseUrl: 'https://student.example' })

  await service.execute({ teacherId: 'teacher-a', email: 'student@example.com', displayNameOrNickname: 'Ayşe' })
  clock.set('2026-10-14T18:00:01.000Z')
  const second = await service.execute({ teacherId: 'teacher-a', email: 'student@example.com', displayNameOrNickname: 'Ayşe' })

  assert.equal(second.invitation.status, 'PENDING')
  assert.equal(repository.snapshot().filter((row) => row.status === 'PENDING').length, 1)
  assert.equal(repository.snapshot().filter((row) => row.status === 'EXPIRED').length, 1)
})

test('resolve invitation returns CREATE or SIGN_IN without exposing token hash', async () => {
  const { createInvitationService, resolveInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const clock = createClock()
  const tokenGenerator = createTokenGenerator()
  const creator = createInvitationService({ repository, clock, tokenGenerator, invitationBaseUrl: 'https://student.example' })

  const created = await creator.execute({ teacherId: 'teacher-a', email: 'new@example.com', displayNameOrNickname: 'Yeni' })
  const resolver = resolveInvitationService({ repository, authDirectory: authDirectory(), clock, tokenGenerator })
  const resolved = await resolver.execute({ rawToken: created.invitationLink.split('/').at(-1) })

  assert.deepEqual(resolved, {
    inviteId: created.invitation.inviteId,
    studentDisplayNameOrNickname: 'Yeni',
    email: 'new@example.com',
    expiresAt: '2026-10-14T18:00:00.000Z',
    accountMode: 'CREATE',
  })
  assert.equal('tokenHash' in resolved, false)

  const repository2 = createInMemoryInvitationRepository()
  const tokenGenerator2 = createTokenGenerator()
  const created2 = await createInvitationService({ repository: repository2, clock, tokenGenerator: tokenGenerator2, invitationBaseUrl: 'https://student.example' }).execute({ teacherId: 'teacher-a', email: 'existing@example.com', displayNameOrNickname: 'Var' })
  const signIn = await resolveInvitationService({ repository: repository2, authDirectory: authDirectory(['existing@example.com']), clock, tokenGenerator: tokenGenerator2 }).execute({ rawToken: created2.invitationLink.split('/').at(-1) })
  assert.equal(signIn.accountMode, 'SIGN_IN')
})

test('expired, revoked, and accepted invitations cannot be resolved', async () => {
  const { resolveInvitationService } = await loadServices()
  const clock = createClock('2026-10-14T18:00:01.000Z')
  const tokenGenerator = createTokenGenerator()

  const pending = createStudentInvitation({
    inviteId: 'invite-expired', teacherId: 'teacher-a', email: 'expired@example.com', studentDisplayNameOrNickname: 'Expired', tokenHash: '0'.repeat(64), createdAt: '2026-10-07T18:00:00.000Z',
  })
  const repository = createInMemoryInvitationRepository([pending])
  const resolver = resolveInvitationService({ repository, authDirectory: authDirectory(), clock, tokenGenerator: { ...tokenGenerator, hashInviteToken: () => '0'.repeat(64) } })
  await assert.rejects(resolver.execute({ rawToken: 'expired' }), /expired/i)
  assert.equal((await repository.getById('invite-expired')).status, 'EXPIRED')

  const revoked = revokeStudentInvitation(createStudentInvitation({
    inviteId: 'invite-revoked', teacherId: 'teacher-a', email: 'revoked@example.com', studentDisplayNameOrNickname: 'Revoked', tokenHash: '1'.repeat(64), createdAt: '2026-10-07T18:00:00.000Z',
  }), '2026-10-07T19:00:00.000Z')
  const accepted = acceptStudentInvitation(createStudentInvitation({
    inviteId: 'invite-accepted', teacherId: 'teacher-a', email: 'accepted@example.com', studentDisplayNameOrNickname: 'Accepted', tokenHash: '2'.repeat(64), createdAt: '2026-10-07T18:00:00.000Z',
  }), { studentId: 'student-a', acceptedAt: '2026-10-07T19:00:00.000Z' })

  for (const [record, hash] of [[revoked, '1'.repeat(64)], [accepted, '2'.repeat(64)]]) {
    const repo = createInMemoryInvitationRepository([record])
    const service = resolveInvitationService({ repository: repo, authDirectory: authDirectory(), clock: createClock('2026-10-07T20:00:00.000Z'), tokenGenerator: { ...tokenGenerator, hashInviteToken: () => hash } })
    await assert.rejects(service.execute({ rawToken: 'replay' }), /pending|revoked|accepted|unavailable/i)
  }
})

test('revoke requires the owning teacher and uses optimistic replacement', async () => {
  const { createInvitationService, revokeInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const clock = createClock()
  const creator = createInvitationService({ repository, clock, tokenGenerator: createTokenGenerator(), invitationBaseUrl: 'https://student.example' })
  const created = await creator.execute({ teacherId: 'teacher-a', email: 'student@example.com', displayNameOrNickname: 'Ayşe' })
  const revoker = revokeInvitationService({ repository, clock })

  await assert.rejects(revoker.execute({ teacherId: 'teacher-b', inviteId: created.invitation.inviteId }), /teacher|forbidden/i)
  assert.equal((await repository.getById(created.invitation.inviteId)).status, 'PENDING')

  const revoked = await revoker.execute({ teacherId: 'teacher-a', inviteId: created.invitation.inviteId })
  assert.equal(revoked.status, 'REVOKED')

  const stale = { ...created.invitation }
  await assert.rejects(repository.replace(stale, revoked), /optimistic/i)
})

test('ambiguous token hash fails closed', async () => {
  const { resolveInvitationService } = await loadServices()
  const repository = createInMemoryInvitationRepository()
  const base = {
    teacherId: 'teacher-a', studentDisplayNameOrNickname: 'Student', tokenHash: 'f'.repeat(64), createdAt: '2026-10-07T18:00:00.000Z',
  }
  repository.unsafeSeed(createStudentInvitation({ ...base, inviteId: 'invite-a', email: 'a@example.com' }))
  repository.unsafeSeed(createStudentInvitation({ ...base, inviteId: 'invite-b', email: 'b@example.com' }))

  const service = resolveInvitationService({ repository, authDirectory: authDirectory(), clock: createClock(), tokenGenerator: { ...createTokenGenerator(), hashInviteToken: () => 'f'.repeat(64) } })
  await assert.rejects(service.execute({ rawToken: 'shared-token' }), /ambiguous/i)
})
