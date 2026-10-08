import { expireStudentInvitation } from '../domain/studentInvitation.js'
import { normalizeRequiredText, normalizeTimestamp } from '../domain/validation.js'
import { assertAuthDirectory } from '../ports/authDirectory.js'
import { assertClock } from '../ports/clock.js'
import { assertInvitationRepository } from '../ports/invitationRepository.js'
import { assertTokenGenerator } from '../ports/tokenGenerator.js'

export function resolveInvitationService({
  repository,
  authDirectory,
  clock,
  tokenGenerator,
} = {}) {
  const invitations = assertInvitationRepository(repository)
  const accounts = assertAuthDirectory(authDirectory)
  const time = assertClock(clock)
  const tokens = assertTokenGenerator(tokenGenerator)

  return Object.freeze({
    async execute({ rawToken } = {}) {
      const token = normalizeRequiredText(rawToken, 'inviteToken', 2048)
      const tokenHash = tokens.hashInviteToken(token)
      const invitation = await invitations.findByTokenHash(tokenHash)
      if (!invitation) throw new Error('invitation-not-found')
      if (invitation.status !== 'PENDING') {
        throw new Error(`invitation-unavailable-${invitation.status.toLowerCase()}`)
      }

      const now = normalizeTimestamp(time.now(), 'clock.now()')
      if (now > invitation.expiresAt) {
        const expired = expireStudentInvitation(invitation, now)
        await invitations.replace(invitation, expired)
        throw new Error('invitation-expired')
      }

      const exists = await accounts.accountExistsByEmail(invitation.emailNormalized)
      return Object.freeze({
        inviteId: invitation.inviteId,
        studentDisplayNameOrNickname: invitation.studentDisplayNameOrNickname,
        email: invitation.emailNormalized,
        expiresAt: invitation.expiresAt,
        accountMode: exists ? 'SIGN_IN' : 'CREATE',
      })
    },
  })
}
