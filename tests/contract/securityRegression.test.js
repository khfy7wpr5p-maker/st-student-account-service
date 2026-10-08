import assert from 'node:assert/strict'
import test from 'node:test'

async function loadComposition() {
  try {
    return await import('../../src/composition.js')
  } catch (error) {
    assert.fail(`service composition must load: ${error.message}`)
  }
}

async function request(app, path, options = {}) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    const { port } = server.address()
    return await fetch(`http://127.0.0.1:${port}${path}`, options)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function baseAdapters(logs, overrides = {}) {
  return {
    clock: { now: () => '2026-10-08T05:00:00.000Z' },
    tokenGenerator: {
      createInviteToken: () => 'generated-invite-token',
      hashInviteToken: () => 'b'.repeat(64),
      createDomainId: (prefix) => `${prefix}-a`,
    },
    tokenVerifier: {
      verifyIdToken: async () => ({ uid: 'firebase-uid-secret', email: 'private.student@example.com' }),
    },
    teacherIdentityResolver: {
      resolveTeacher: async () => ({ teacherId: 'teacher-a', active: true }),
    },
    authDirectory: { accountExistsByEmail: async () => false },
    invitationRepository: {
      create: async (record) => record,
      findPendingByTeacherAndEmail: async () => null,
      findByTokenHash: async () => null,
      getById: async () => null,
      replace: async (_expected, next) => next,
      listByTeacherId: async () => [],
    },
    studentAccountRepository: {
      findByFirebaseUid: async () => null,
      getByStudentId: async () => null,
      createActivating: async (record) => record,
      markActive: async () => null,
    },
    relationshipRepository: {
      beginActivation: async (record) => record,
      markActive: async () => null,
      getBySourceInviteId: async () => null,
    },
    usageRepository: {
      recordSessionOnce: async () => ({ isNew: true, totalSessions: 1, lastSessionAt: '2026-10-08T05:00:00.000Z' }),
      getSummary: async () => null,
    },
    presenceReader: {
      getPresenceByFirebaseUid: async () => ({ state: 'UNKNOWN', lastOnlineAt: null }),
    },
    logger: (event) => logs.push(event),
    ...overrides,
  }
}

function serviceConfig() {
  return {
    mode: 'development',
    projectId: 'demo-st-student-account',
    invitationBaseUrl: 'http://localhost:3000',
  }
}

test('closed non-production activation returns bounded 503 and logs no bearer, uid, or email', async () => {
  const { createStudentAccountService } = await loadComposition()
  const logs = []
  const service = createStudentAccountService({
    config: serviceConfig(),
    adapters: baseAdapters(logs, { secureDeliveryAuthorityPort: null }),
  })
  const bearer = 'very-secret-firebase-id-token'
  const inviteToken = 'very-secret-invite-token'
  try {
    const response = await request(service.app, '/api/student-accounts/v1/student/invitations/accept', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inviteToken }),
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' })

    const serialized = JSON.stringify(logs)
    for (const secret of [bearer, inviteToken, 'firebase-uid-secret', 'private.student@example.com']) {
      assert.equal(serialized.includes(secret), false, `observability leaked ${secret}`)
    }
    assert.equal(logs.length, 1)
    assert.equal(logs[0].status, 503)
    assert.equal(logs[0].routeClass, 'STUDENT_API')
    assert.equal(typeof logs[0].requestId, 'string')
    assert.equal(Number.isFinite(logs[0].latencyMs), true)
  } finally {
    await service.close?.()
  }
})

test('internal backend errors and request bodies remain absent from public errors and structured logs', async () => {
  const { createStudentAccountService } = await loadComposition()
  const logs = []
  const secretInvite = 'resolve-secret-token'
  const secretEmail = 'hidden@example.com'
  const secretUid = 'hidden-firebase-uid'
  const secretPath = 'studentAccounts/private-document'
  const adapters = baseAdapters(logs)
  adapters.invitationRepository.findByTokenHash = async () => {
    throw new Error(`backend failure ${secretEmail} ${secretUid} ${secretPath}`)
  }
  const service = createStudentAccountService({ config: serviceConfig(), adapters })
  try {
    const response = await request(service.app, '/api/student-accounts/v1/public/invitations/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: secretInvite }),
    })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.deepEqual(body, { error: 'INTERNAL_ERROR' })

    const serialized = JSON.stringify({ body, logs })
    for (const secret of [secretInvite, secretEmail, secretUid, secretPath]) {
      assert.equal(serialized.includes(secret), false, `serialization leaked ${secret}`)
    }
    assert.equal(logs.length, 1)
    assert.equal(logs[0].routeClass, 'PUBLIC_API')
    assert.equal(logs[0].status, 500)
  } finally {
    await service.close?.()
  }
})

test('health observability is bounded and contains no provider configuration', async () => {
  const { createStudentAccountService } = await loadComposition()
  const logs = []
  const service = createStudentAccountService({
    config: serviceConfig(),
    adapters: baseAdapters(logs),
  })
  try {
    const response = await request(service.app, '/health')
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(logs.length, 1)
    const serialized = JSON.stringify(logs[0])
    assert.equal(serialized.includes('demo-st-student-account'), false)
    assert.equal(serialized.includes('FIRESTORE'), false)
    assert.equal(logs[0].routeClass, 'HEALTH')
  } finally {
    await service.close?.()
  }
})
