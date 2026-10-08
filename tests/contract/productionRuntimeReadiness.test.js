import assert from 'node:assert/strict'
import test from 'node:test'

async function loadTeacherResolver() {
  try {
    return await import('../../src/adapters/secureDelivery/firestoreSecureDeliveryTeacherIdentityResolver.js')
  } catch {
    return null
  }
}

function snapshot(data) {
  return data === null
    ? { exists: false, data: () => undefined }
    : { exists: true, data: () => data }
}

function documentId(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function bindingId(role, stableId) {
  return Buffer.from(JSON.stringify([role, stableId]), 'utf8').toString('base64url')
}

function fakeSecureDeliveryDb({ identity, binding } = {}) {
  const reads = []
  return {
    reads,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              reads.push([name, id])
              if (name === 'identityMappings') return snapshot(identity ?? null)
              if (name === 'identityDomainBindings') return snapshot(binding ?? null)
              return snapshot(null)
            },
          }
        },
      }
    },
  }
}

function fakeAdapters() {
  return {
    clock: { now: () => '2026-10-08T14:00:00.000Z' },
    tokenGenerator: {
      createInviteToken: () => 'invite-token',
      hashInviteToken: () => 'a'.repeat(64),
      createDomainId: (prefix) => `${prefix}-a`,
    },
    tokenVerifier: {
      verifyIdToken: async () => ({ uid: 'firebase-teacher-a', email: 'teacher@example.com' }),
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
      recordSessionOnce: async () => ({ isNew: true, totalSessions: 1, lastSessionAt: '2026-10-08T14:00:00.000Z' }),
      getSummary: async () => null,
    },
    presenceReader: {
      getPresenceByFirebaseUid: async () => ({ state: 'UNKNOWN', lastOnlineAt: null }),
    },
    secureDeliveryAuthorityPort: {
      activateStudent: async () => ({
        studentId: 'student-a',
        teacherId: 'teacher-a',
        identityActive: true,
        grantActive: true,
      }),
    },
    logger: () => {},
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

test('production environment parses the bounded browser origin allowlist', async () => {
  const { configFromEnvironment } = await import('../../src/server.js')
  const config = configFromEnvironment({
    NODE_ENV: 'production',
    FIREBASE_PROJECT_ID: 'st-student-app-85cde',
    STUDENT_INVITATION_BASE_URL: 'https://st-student-app.onrender.com',
    ACCOUNT_SERVICE_ALLOWED_ORIGINS:
      'https://st-student-app.onrender.com, https://seslitab-app.onrender.com',
  })

  assert.deepEqual(config.allowedOrigins, [
    'https://st-student-app.onrender.com',
    'https://seslitab-app.onrender.com',
  ])
})

test('allowed production browser origin receives strict preflight headers', async () => {
  const { createStudentAccountService } = await import('../../src/composition.js')
  const service = createStudentAccountService({
    config: {
      mode: 'production',
      projectId: 'st-student-app-85cde',
      invitationBaseUrl: 'https://st-student-app.onrender.com',
      allowedOrigins: [
        'https://st-student-app.onrender.com',
        'https://seslitab-app.onrender.com',
      ],
    },
    adapters: fakeAdapters(),
  })

  try {
    const response = await request(
      service.app,
      '/api/student-accounts/v1/teacher/students',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://seslitab-app.onrender.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      },
    )
    assert.equal(response.status, 204)
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://seslitab-app.onrender.com',
    )
    assert.match(
      response.headers.get('access-control-allow-headers') ?? '',
      /authorization/i,
    )
    assert.match(
      response.headers.get('access-control-allow-methods') ?? '',
      /GET/i,
    )
  } finally {
    await service.close()
  }
})

test('unapproved production browser origin fails closed before API routing', async () => {
  const { createStudentAccountService } = await import('../../src/composition.js')
  const service = createStudentAccountService({
    config: {
      mode: 'production',
      projectId: 'st-student-app-85cde',
      invitationBaseUrl: 'https://st-student-app.onrender.com',
      allowedOrigins: ['https://st-student-app.onrender.com'],
    },
    adapters: fakeAdapters(),
  })

  try {
    const response = await request(
      service.app,
      '/api/student-accounts/v1/public/invitations/resolve',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
        },
      },
    )
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  } finally {
    await service.close()
  }
})

test('Secure Delivery teacher resolver requires active identity plus matching reverse binding', async () => {
  const module = await loadTeacherResolver()
  assert.equal(
    typeof module?.createFirestoreSecureDeliveryTeacherIdentityResolver,
    'function',
    'production teacher resolver must exist',
  )

  const firebaseUid = 'firebase-teacher-a'
  const teacherId = 'teacher-a'
  const db = fakeSecureDeliveryDb({
    identity: {
      schemaVersion: 1,
      providerSubject: firebaseUid,
      role: 'TEACHER',
      teacherId,
      studentId: null,
      active: true,
      createdAt: '2026-10-01T10:00:00.000Z',
      disabledAt: null,
    },
    binding: {
      role: 'TEACHER',
      stableId: teacherId,
      providerSubject: firebaseUid,
    },
  })

  const resolver =
    module.createFirestoreSecureDeliveryTeacherIdentityResolver({ db })
  assert.deepEqual(await resolver.resolveTeacher(firebaseUid), {
    teacherId,
    active: true,
  })
  assert.deepEqual(db.reads, [
    ['identityMappings', documentId(firebaseUid)],
    ['identityDomainBindings', bindingId('TEACHER', teacherId)],
  ])
})

test('Secure Delivery teacher resolver fails closed on binding mismatch', async () => {
  const module = await loadTeacherResolver()
  assert.equal(
    typeof module?.createFirestoreSecureDeliveryTeacherIdentityResolver,
    'function',
    'production teacher resolver must exist',
  )

  const db = fakeSecureDeliveryDb({
    identity: {
      schemaVersion: 1,
      providerSubject: 'firebase-teacher-a',
      role: 'TEACHER',
      teacherId: 'teacher-a',
      studentId: null,
      active: true,
      createdAt: '2026-10-01T10:00:00.000Z',
      disabledAt: null,
    },
    binding: {
      role: 'TEACHER',
      stableId: 'teacher-a',
      providerSubject: 'different-provider',
    },
  })

  const resolver =
    module.createFirestoreSecureDeliveryTeacherIdentityResolver({ db })
  assert.equal(await resolver.resolveTeacher('firebase-teacher-a'), null)
})
