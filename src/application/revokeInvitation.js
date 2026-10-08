import { revokeStudentInvitation } from '../domain/studentInvitation.js'
import { normalizeRequiredId, normalizeTimestamp } from '../domain/validation.js'
import { assertClock } from '../ports/clock.js'
import { assertInvitationRepository } from '../ports/invitationRepository.js'

export function revokeInvitationService({ repository, clock } = {}) {
  const invitations = assertInvitationRepository(repository)
  const time = assertClock(clock)

  return Object.freeze({
    async execute({ teacherId, inviteId } = {}) {
      const stableTeacherId = normalizeRequiredId(teacherId, 'teacherId')
      const stableInviteId = normalizeRequiredId(inviteId, 'inviteId')
      const invitation = await invitations.getById(stableInviteId)
      if (!invitation) throw new Error('invitation-not-found')
      if (invitation.teacherId !== stableTeacherId) {
        throw new Error('forbidden-teacher-invitation')
      }
      const revoked = revokeStudentInvitation(
        invitation,
        normalizeTimestamp(time.now(), 'clock.now()'),
      )
      return invitations.replace(invitation, revoked)
    },
  })
}
