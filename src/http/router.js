import express from 'express'

import { assertStrictInputObject, normalizeRequiredId, normalizeRequiredText } from '../domain/validation.js'
import { assertTeacherIdentityResolver } from '../ports/teacherIdentityResolver.js'
import { assertTokenVerifier } from '../ports/tokenVerifier.js'
import { readBearerToken } from './bearerToken.js'
import { boundaryError, toHttpError } from './errorResponse.js'

function assertService(service, name) {
  if (!service || typeof service !== 'object' || typeof service.execute !== 'function') {
    throw new TypeError(`${name} must provide execute().`)
  }
  return service
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response)).catch(next)
  }
}

export function createStudentAccountRouter({
  tokenVerifier,
  teacherIdentityResolver,
  createInvitationService,
  resolveInvitationService,
  revokeInvitationService,
  acceptInvitationService = null,
  recordStudentSessionService = null,
} = {}) {
  const verifier = assertTokenVerifier(tokenVerifier)
  const teachers = assertTeacherIdentityResolver(teacherIdentityResolver)
  const createInvitation = assertService(createInvitationService, 'createInvitationService')
  const resolveInvitation = assertService(resolveInvitationService, 'resolveInvitationService')
  const revokeInvitation = assertService(revokeInvitationService, 'revokeInvitationService')
  const acceptInvitation = acceptInvitationService === null
    ? null
    : assertService(acceptInvitationService, 'acceptInvitationService')
  const recordStudentSession = recordStudentSessionService === null
    ? null
    : assertService(recordStudentSessionService, 'recordStudentSessionService')

  async function authenticatedUser(request) {
    const bearerToken = readBearerToken(request)
    try {
      return await verifier.verifyIdToken(bearerToken)
    } catch {
      throw boundaryError('UNAUTHORIZED')
    }
  }

  async function authenticatedTeacherId(request) {
    const authenticated = await authenticatedUser(request)
    const mapping = await teachers.resolveTeacher(authenticated.uid)
    if (!mapping || mapping.active !== true) {
      throw boundaryError('FORBIDDEN')
    }
    try {
      return normalizeRequiredId(mapping.teacherId, 'teacherId')
    } catch {
      throw boundaryError('FORBIDDEN')
    }
  }

  const router = express.Router()
  router.use(express.json({ limit: '16kb', strict: true }))

  router.post('/api/student-accounts/v1/public/invitations/resolve', asyncRoute(async (request, response) => {
    assertStrictInputObject(request.body, ['inviteToken'], 'resolve invitation request')
    const rawToken = normalizeRequiredText(request.body.inviteToken, 'inviteToken', 2048)
    const result = await resolveInvitation.execute({ rawToken })
    response.status(200).json(result)
  }))

  router.post('/api/student-accounts/v1/teacher/invitations', asyncRoute(async (request, response) => {
    const teacherId = await authenticatedTeacherId(request)
    assertStrictInputObject(
      request.body,
      ['email', 'displayNameOrNickname'],
      'create invitation request',
    )
    const result = await createInvitation.execute({
      teacherId,
      email: request.body.email,
      displayNameOrNickname: request.body.displayNameOrNickname,
    })
    const invitation = result.invitation
    response.status(201).json({
      inviteId: invitation.inviteId,
      displayNameOrNickname: invitation.studentDisplayNameOrNickname,
      email: invitation.emailNormalized,
      expiresAt: invitation.expiresAt,
      state: 'INVITED',
      invitationLink: result.invitationLink,
    })
  }))

  router.post('/api/student-accounts/v1/teacher/invitations/:inviteId/revoke', asyncRoute(async (request, response) => {
    const teacherId = await authenticatedTeacherId(request)
    const inviteId = normalizeRequiredId(request.params.inviteId, 'inviteId')
    const result = await revokeInvitation.execute({ teacherId, inviteId })
    response.status(200).json({ inviteId: result.inviteId, status: result.status })
  }))

  if (acceptInvitation) {
    router.post('/api/student-accounts/v1/student/invitations/accept', asyncRoute(async (request, response) => {
      const authenticated = await authenticatedUser(request)
      assertStrictInputObject(request.body, ['inviteToken'], 'accept invitation request')
      const rawToken = normalizeRequiredText(request.body.inviteToken, 'inviteToken', 2048)
      const result = await acceptInvitation.execute({ rawToken, authenticatedUser: authenticated })
      response.status(200).json({
        studentId: result.studentId,
        relationshipState: result.relationshipState,
      })
    }))
  }

  if (recordStudentSession) {
    router.post('/api/student-accounts/v1/student/sessions', asyncRoute(async (request, response) => {
      const bearerToken = readBearerToken(request)
      assertStrictInputObject(request.body, ['clientSessionId'], 'record student session request')
      const result = await recordStudentSession.execute({
        bearerToken,
        clientSessionId: request.body.clientSessionId,
      })
      response.status(200).json({
        isNew: result.isNew,
        totalSessions: result.totalSessions,
        lastSessionAt: result.lastSessionAt,
      })
    }))
  }

  router.use((error, _request, response, _next) => {
    const { status, body } = toHttpError(error)
    response.status(status).json(body)
  })

  return router
}
