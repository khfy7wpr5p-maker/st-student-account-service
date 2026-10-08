import { acceptStudentInvitation, expireStudentInvitation } from '../domain/studentInvitation.js'
import { createStudentAccount } from '../domain/studentAccount.js'
import { createTeacherStudentRelationship } from '../domain/teacherStudentRelationship.js'
import { normalizeEmail, normalizeRequiredId, normalizeRequiredText, normalizeTimestamp } from '../domain/validation.js'
import { assertClock } from '../ports/clock.js'
import { assertInvitationRepository } from '../ports/invitationRepository.js'
import { assertRelationshipRepository } from '../ports/relationshipRepository.js'
import { assertSecureDeliveryAuthorityPort } from '../ports/secureDeliveryAuthorityPort.js'
import { assertStudentAccountRepository } from '../ports/studentAccountRepository.js'
import { assertTokenGenerator } from '../ports/tokenGenerator.js'

function assertAccountMatches(account, { uid, email }) {
  if (account.firebaseUid !== uid || account.emailNormalized !== email) {
    throw new Error('student-identity-conflict')
  }
  return account
}

function assertRelationshipMatches(relationship, invitation, studentId) {
  if (
    relationship.teacherId !== invitation.teacherId ||
    relationship.studentId !== studentId ||
    relationship.sourceInviteId !== invitation.inviteId
  ) {
    throw new Error('relationship-conflict')
  }
  return relationship
}

export function acceptInvitationService({
  invitationRepository,
  studentAccountRepository,
  relationshipRepository,
  secureDeliveryAuthorityPort,
  clock,
  tokenGenerator,
} = {}) {
  const invitations = assertInvitationRepository(invitationRepository)
  const accounts = assertStudentAccountRepository(studentAccountRepository)
  const relationships = assertRelationshipRepository(relationshipRepository)
  const authority = assertSecureDeliveryAuthorityPort(secureDeliveryAuthorityPort)
  const time = assertClock(clock)
  const tokens = assertTokenGenerator(tokenGenerator)

  async function resolveOrCreateAccount({ uid, email, now }) {
    const existing = await accounts.findByFirebaseUid(uid)
    if (existing) return assertAccountMatches(existing, { uid, email })

    const candidate = createStudentAccount({
      studentId: tokens.createDomainId('student'),
      firebaseUid: uid,
      email,
      createdAt: now,
      active: false,
    })
    try {
      return await accounts.createActivating(candidate)
    } catch (error) {
      const winner = await accounts.findByFirebaseUid(uid)
      if (!winner) throw error
      return assertAccountMatches(winner, { uid, email })
    }
  }

  async function resolveOrCreateRelationship({ invitation, studentId, now }) {
    const existing = await relationships.getBySourceInviteId(invitation.inviteId)
    if (existing) return assertRelationshipMatches(existing, invitation, studentId)

    const candidate = createTeacherStudentRelationship({
      relationshipId: tokens.createDomainId('relationship'),
      teacherId: invitation.teacherId,
      studentId,
      displayNameOrNickname: invitation.studentDisplayNameOrNickname,
      active: false,
      createdAt: now,
      activatedAt: null,
      deactivatedAt: null,
      sourceInviteId: invitation.inviteId,
    })
    try {
      return await relationships.beginActivation(candidate)
    } catch (error) {
      const winner = await relationships.getBySourceInviteId(invitation.inviteId)
      if (!winner) throw error
      return assertRelationshipMatches(winner, invitation, studentId)
    }
  }

  async function finalizeInvitation(invitation, studentId, now) {
    const accepted = acceptStudentInvitation(invitation, {
      studentId,
      acceptedAt: now,
    })
    try {
      return await invitations.replace(invitation, accepted)
    } catch (error) {
      const current = await invitations.getById(invitation.inviteId)
      if (
        current?.status === 'ACCEPTED' &&
        current.studentId === studentId
      ) {
        return current
      }
      throw error
    }
  }

  return Object.freeze({
    async execute({ rawToken, authenticatedUser } = {}) {
      const inviteToken = normalizeRequiredText(rawToken, 'inviteToken', 2048)
      const uid = normalizeRequiredId(authenticatedUser?.uid, 'authenticated uid')
      const email = normalizeEmail(authenticatedUser?.email, 'authenticated email')
      const now = normalizeTimestamp(time.now(), 'clock.now()')
      const tokenHash = tokens.hashInviteToken(inviteToken)

      const invitation = await invitations.findByTokenHash(tokenHash)
      if (!invitation) throw new Error('invitation-not-found')
      if (invitation.status !== 'PENDING') {
        throw new Error(`invitation-unavailable-${invitation.status.toLowerCase()}`)
      }
      if (now > invitation.expiresAt) {
        const expired = expireStudentInvitation(invitation, now)
        await invitations.replace(invitation, expired)
        throw new Error('invitation-expired')
      }
      if (email !== invitation.emailNormalized) {
        throw new Error('invitation-email-mismatch')
      }

      const account = await resolveOrCreateAccount({ uid, email, now })
      const relationship = await resolveOrCreateRelationship({
        invitation,
        studentId: account.studentId,
        now,
      })

      const acknowledgement = await authority.activateStudent({
        firebaseUid: uid,
        teacherId: invitation.teacherId,
        studentId: account.studentId,
        displayNameOrNickname: relationship.displayNameOrNickname,
        activatedAt: now,
        sourceInviteId: invitation.inviteId,
      })
      if (
        acknowledgement?.studentId !== account.studentId ||
        acknowledgement?.teacherId !== invitation.teacherId ||
        acknowledgement?.identityActive !== true ||
        acknowledgement?.grantActive !== true
      ) {
        throw new Error('secure-delivery-authority-ack-mismatch')
      }

      await accounts.markActive(account.studentId)
      const activeRelationship = await relationships.markActive(
        relationship.relationshipId,
        now,
      )
      const acceptedInvitation = await finalizeInvitation(
        invitation,
        account.studentId,
        now,
      )

      return Object.freeze({
        studentId: account.studentId,
        relationshipState: activeRelationship.active && acceptedInvitation.status === 'ACCEPTED'
          ? 'ACTIVE'
          : 'ACTIVATING',
        invitation: acceptedInvitation,
      })
    },
  })
}
