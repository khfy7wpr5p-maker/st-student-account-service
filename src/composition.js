import { createHash, randomBytes } from 'node:crypto'
import express from 'express'

import { acceptInvitationService } from './application/acceptInvitation.js'
import { createInvitationService } from './application/createInvitation.js'
import { listTeacherStudentsService } from './application/listTeacherStudents.js'
import { recordStudentSessionService } from './application/recordStudentSession.js'
import { resolveInvitationService } from './application/resolveInvitation.js'
import { revokeInvitationService } from './application/revokeInvitation.js'
import { createFirebaseAdminAccess } from './adapters/firebase/firebaseAdmin.js'
import { createFirebaseAuthDirectory } from './adapters/firebase/firebaseAuthDirectory.js'
import { createFirebaseTokenVerifier } from './adapters/firebase/firebaseTokenVerifier.js'
import { createFirestoreInvitationRepository } from './adapters/firebase/firestoreInvitationRepository.js'
import { createFirestoreRelationshipRepository } from './adapters/firebase/firestoreRelationshipRepository.js'
import { createFirestoreStudentAccountRepository } from './adapters/firebase/firestoreStudentAccountRepository.js'
import { createFirestoreUsageRepository } from './adapters/firebase/firestoreUsageRepository.js'
import { createRealtimePresenceReader } from './adapters/firebase/realtimePresenceReader.js'
import { normalizeRequiredText } from './domain/validation.js'
import { createStudentAccountRouter } from './http/router.js'
import { boundaryError } from './http/errorResponse.js'

function requiredConfigText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function normalizeMode(value) {
  if (value === undefined || value === null) return 'development'
  return requiredConfigText(value, 'mode').toLowerCase()
}

function defaultClock() {
  return Object.freeze({ now: () => new Date().toISOString() })
}

function defaultTokenGenerator() {
  return Object.freeze({
    createInviteToken() {
      return randomBytes(32).toString('base64url')
    },
    hashInviteToken(rawToken) {
      const token = normalizeRequiredText(rawToken, 'inviteToken', 2048)
      return createHash('sha256').update(token, 'utf8').digest('hex')
    },
    createDomainId(prefix) {
      const stablePrefix = normalizeRequiredText(prefix, 'domain id prefix', 32)
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(stablePrefix)) {
        throw new TypeError('domain id prefix must be path-safe.')
      }
      return `${stablePrefix}-${randomBytes(16).toString('hex')}`
    },
  })
}

const CLOSED_TEACHER_IDENTITY_RESOLVER = Object.freeze({
  async resolveTeacher() {
    return null
  },
})

function unavailableActivationService() {
  return Object.freeze({
    async execute() {
      throw boundaryError('SERVICE_UNAVAILABLE')
    },
  })
}

function routeClass(path) {
  if (path === '/health') return 'HEALTH'
  if (path.startsWith('/api/student-accounts/v1/public/')) return 'PUBLIC_API'
  if (path.startsWith('/api/student-accounts/v1/teacher/')) return 'TEACHER_API'
  if (path.startsWith('/api/student-accounts/v1/student/')) return 'STUDENT_API'
  return 'UNKNOWN'
}

function outcomeFor(status) {
  if (status < 400) return 'SUCCESS'
  if (status < 500) return 'CLIENT_ERROR'
  return 'SERVER_ERROR'
}

function normalizeLogger(logger) {
  if (logger === undefined || logger === null) {
    return (event) => {
      console.info(JSON.stringify(event))
    }
  }
  if (typeof logger !== 'function') throw new TypeError('logger must be a function.')
  return logger
}

function privacySafeObservability(logger) {
  return (request, response, next) => {
    const startedAt = process.hrtime.bigint()
    const requestId = randomBytes(12).toString('hex')
    response.setHeader('x-request-id', requestId)
    response.once('finish', () => {
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const event = Object.freeze({
        event: 'http_request',
        requestId,
        routeClass: routeClass(request.path),
        status: response.statusCode,
        outcome: outcomeFor(response.statusCode),
        latencyMs: Math.round(elapsed * 1000) / 1000,
      })
      try {
        logger(event)
      } catch {
        // Observability must never change request behavior.
      }
    })
    next()
  }
}

export function createStudentAccountService({ config = {}, adapters = {} } = {}) {
  const mode = normalizeMode(config.mode)
  const projectId = requiredConfigText(config.projectId, 'projectId')
  const invitationBaseUrl = requiredConfigText(config.invitationBaseUrl, 'invitationBaseUrl')
  const logger = normalizeLogger(adapters.logger)
  const authority = adapters.secureDeliveryAuthorityPort ?? null

  if (mode === 'production' && !authority) {
    throw new TypeError('SecureDeliveryAuthorityPort is required in production.')
  }

  let adminAccess = adapters.firebaseAdminAccess ?? null
  let closed = false
  function firebaseAdmin() {
    if (closed) throw new Error('student-account-service-closed')
    if (!adminAccess) {
      adminAccess = createFirebaseAdminAccess({
        projectId,
        databaseURL: config.databaseURL,
        emulator: config.emulator,
        appName: config.firebaseAppName,
      })
    }
    return adminAccess
  }

  const clock = adapters.clock ?? defaultClock()
  const tokenGenerator = adapters.tokenGenerator ?? defaultTokenGenerator()
  const tokenVerifier = adapters.tokenVerifier ?? createFirebaseTokenVerifier({
    auth: firebaseAdmin().getAuth(),
  })
  const authDirectory = adapters.authDirectory ?? createFirebaseAuthDirectory({
    auth: firebaseAdmin().getAuth(),
  })
  const invitationRepository = adapters.invitationRepository ?? createFirestoreInvitationRepository({
    db: firebaseAdmin().getFirestore(),
  })
  const studentAccountRepository = adapters.studentAccountRepository ?? createFirestoreStudentAccountRepository({
    db: firebaseAdmin().getFirestore(),
  })
  const relationshipRepository = adapters.relationshipRepository ?? createFirestoreRelationshipRepository({
    db: firebaseAdmin().getFirestore(),
  })
  const usageRepository = adapters.usageRepository ?? createFirestoreUsageRepository({
    db: firebaseAdmin().getFirestore(),
  })
  const presenceReader = adapters.presenceReader ?? createRealtimePresenceReader({
    database: firebaseAdmin().getDatabase(),
  })
  const teacherIdentityResolver = adapters.teacherIdentityResolver ?? CLOSED_TEACHER_IDENTITY_RESOLVER

  const createInvitation = createInvitationService({
    repository: invitationRepository,
    clock,
    tokenGenerator,
    invitationBaseUrl,
  })
  const resolveInvitation = resolveInvitationService({
    repository: invitationRepository,
    authDirectory,
    clock,
    tokenGenerator,
  })
  const revokeInvitation = revokeInvitationService({ repository: invitationRepository, clock })
  const acceptInvitation = authority
    ? acceptInvitationService({
        invitationRepository,
        studentAccountRepository,
        relationshipRepository,
        secureDeliveryAuthorityPort: authority,
        clock,
        tokenGenerator,
      })
    : unavailableActivationService()
  const recordStudentSession = recordStudentSessionService({
    tokenVerifier,
    studentAccountRepository,
    usageRepository,
    clock,
  })
  const listTeacherStudents = listTeacherStudentsService({
    invitationRepository,
    studentAccountRepository,
    relationshipRepository,
    usageRepository,
    presenceReader,
  })

  const router = createStudentAccountRouter({
    tokenVerifier,
    teacherIdentityResolver,
    createInvitationService: createInvitation,
    resolveInvitationService: resolveInvitation,
    revokeInvitationService: revokeInvitation,
    acceptInvitationService: acceptInvitation,
    recordStudentSessionService: recordStudentSession,
    listTeacherStudentsService: listTeacherStudents,
  })

  const app = express()
  app.disable('x-powered-by')
  app.use(privacySafeObservability(logger))
  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' })
  })
  app.use(router)

  return Object.freeze({
    app,
    async close() {
      if (closed) return
      closed = true
      if (adminAccess && typeof adminAccess.close === 'function') {
        await adminAccess.close()
      }
    },
  })
}
