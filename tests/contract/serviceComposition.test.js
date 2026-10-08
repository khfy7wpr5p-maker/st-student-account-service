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

function config(overrides = {}) {
  return {
    mode: 'test',
    projectId: 'demo-st-student-account',
    invitationBaseUrl: 'http://localhost:3000',
    ...overrides,
  }
}

function fakeAdapters(overrides = {}) {
  return {
    clock: { now: () => '2026-10-08T05:00:00.000Z' },
    tokenGenerator: {
      createInviteToken: () => 'invite-token',
      hashInviteToken: () => 'a'.repeat(64),
      createDomainId: (prefix) => `${prefix}-a`,
    },
    tokenVerifier: {
      verifyIdToken: async () => ({ uid: 'firebase-uid-a', email: 'student@example.com' }),
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
    logger: () => {},
    ...overrides,
  }
}

test('health endpoint is bounded and provider-neutral', async () => {
  const { createStudentAccountService } = await loadComposition()
  const service = createStudentAccountService({ config: config(), adapters: fakeAdapters() })
  try {
    const response = await request(service.app, '/health')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
    assert.equal(response.headers.get('x-powered-by'), null)
  } finally {
    await service.close?.()
  }
})

test('missing Firebase project configuration fails before startup', async () => {
  const { createStudentAccountService } = await loadComposition()
  assert.throws(
    () => createStudentAccountService({
      config: { mode: 'test', invitationBaseUrl: 'http://localhost:3000' },
      adapters: fakeAdapters(),
    }),
    /projectId/i,
  )
})

test('production composition refuses to start without SecureDeliveryAuthorityPort', async () => {
  const { createStudentAccountService } = await loadComposition()
  assert.throws(
    () => createStudentAccountService({
      config: config({ mode: 'production', invitationBaseUrl: 'https://student.example.test' }),
      adapters: fakeAdapters({ secureDeliveryAuthorityPort: null }),
    }),
    /SecureDeliveryAuthorityPort/i,
  )
})

test('Firebase Admin detects emulator hosts, avoids credentials, exposes all stores, and closes once', async () => {
  const previous = process.env.FIRESTORE_EMULATOR_HOST
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
  try {
    const { createFirebaseAdminAccess } = await import('../../src/adapters/firebase/firebaseAdmin.js')
    const app = { name: 'account-contract-emulator' }
    let options = null
    let credentialCalls = 0
    let deleteCalls = 0
    const access = createFirebaseAdminAccess({
      projectId: 'demo-st-student-account',
      appName: 'account-contract-emulator',
      appFactory: (nextOptions) => {
        options = nextOptions
        return app
      },
      authFactory: (received) => ({ kind: 'auth', app: received }),
      firestoreFactory: (received) => ({ kind: 'firestore', app: received }),
      databaseFactory: (received) => ({ kind: 'database', app: received }),
      credentialFactory: () => {
        credentialCalls += 1
        return { forbidden: true }
      },
      deleteAppFactory: async (received) => {
        assert.equal(received, app)
        deleteCalls += 1
      },
    })

    assert.equal(access.getAuth().app, app)
    assert.equal(access.getFirestore().app, app)
    assert.equal(access.getDatabase().app, app)
    assert.equal(credentialCalls, 0)
    assert.equal('credential' in options, false)

    await access.close()
    await access.close()
    assert.equal(deleteCalls, 1)
  } finally {
    if (previous === undefined) delete process.env.FIRESTORE_EMULATOR_HOST
    else process.env.FIRESTORE_EMULATOR_HOST = previous
  }
})

test('service close is idempotent and releases composed Firebase Admin access', async () => {
  const { createStudentAccountService } = await loadComposition()
  let closeCalls = 0
  const firestore = {
    collection: () => ({}),
    runTransaction: async () => {},
  }
  const firebaseAdminAccess = {
    getAuth: () => ({
      verifyIdToken: async () => ({ uid: 'uid-a', email: 'student@example.com' }),
      getUserByEmail: async () => { const error = new Error('missing'); error.code = 'auth/user-not-found'; throw error },
    }),
    getFirestore: () => firestore,
    getDatabase: () => ({ ref: () => ({ once: async () => ({ val: () => null }) }) }),
    close: async () => { closeCalls += 1 },
  }
  const service = createStudentAccountService({
    config: config(),
    adapters: { firebaseAdminAccess, logger: () => {} },
  })
  await service.close()
  await service.close()
  assert.equal(closeCalls, 1)
})
