import { createStudentInvitation, expireStudentInvitation } from '../domain/studentInvitation.js'
import { normalizeEmail, normalizeRequiredId, normalizeRequiredText, normalizeTimestamp } from '../domain/validation.js'
import { assertClock } from '../ports/clock.js'
import { assertInvitationRepository } from '../ports/invitationRepository.js'
import { assertTokenGenerator } from '../ports/tokenGenerator.js'

function normalizeInvitationBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('invitationBaseUrl must be a non-empty URL.')
  }
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError('invitationBaseUrl must be a valid URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new TypeError('invitationBaseUrl must use https outside localhost.')
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/, '')
}

export function createInvitationService({
  repository,
  clock,
  tokenGenerator,
  invitationBaseUrl,
} = {}) {
  const invitations = assertInvitationRepository(repository)
  const time = assertClock(clock)
  const tokens = assertTokenGenerator(tokenGenerator)
  const baseUrl = normalizeInvitationBaseUrl(invitationBaseUrl)

  return Object.freeze({
    async execute({ teacherId, email, displayNameOrNickname } = {}) {
      const stableTeacherId = normalizeRequiredId(teacherId, 'teacherId')
      const emailNormalized = normalizeEmail(email)
      const displayName = normalizeRequiredText(
        displayNameOrNickname,
        'displayNameOrNickname',
        200,
      )
      const now = normalizeTimestamp(time.now(), 'clock.now()')

      const existing = await invitations.findPendingByTeacherAndEmail(
        stableTeacherId,
        emailNormalized,
      )
      if (existing) {
        if (now > existing.expiresAt) {
          const expired = expireStudentInvitation(existing, now)
          await invitations.replace(existing, expired)
        } else {
          throw new Error('pending-invitation-conflict')
        }
      }

      const rawToken = tokens.createInviteToken()
      const tokenHash = tokens.hashInviteToken(rawToken)
      const invitation = createStudentInvitation({
        inviteId: tokens.createDomainId('invite'),
        teacherId: stableTeacherId,
        email: emailNormalized,
        studentDisplayNameOrNickname: displayName,
        tokenHash,
        createdAt: now,
      })

      const persisted = await invitations.create(invitation)
      const invitationLink = `${baseUrl}/#/invite/${encodeURIComponent(rawToken)}`
      return Object.freeze({ invitation: persisted, invitationLink })
    },
  })
}
