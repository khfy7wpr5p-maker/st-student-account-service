import assert from 'node:assert/strict'
import test from 'node:test'

function baseConfig(overrides = {}) {
  return {
    mode: 'production',
    projectId: 'account-project',
    invitationBaseUrl: 'https://student.example.test',
    ...overrides,
  }
}

function applicationAdapters(overrides = {}) {
  return {
    clock: { now: () => '2026-10-08T10:00:00.000Z' },
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
      recordSessionOnce: async () => ({ isNew: true, totalSessions: 1, lastSessionAt: null }),
      getSummary: async () => null,
    },
    presenceReader: {
      getPresenceByFirebaseUid: async () => ({ state: 'UNKNOWN', lastOnlineAt: null }),
    },
    logger: () => {},
    ...overrides,
  }
}

function authorityFirestore() {
  return {
    collection() {
      return { doc: () => ({}) }
    },
    async runTransaction() {
      throw new Error('not-used-during-composition')
    },
  }
}

test('server environment exposes authority binding and optional separate Secure Delivery project without enabling it by default', async () => {
  const { configFromEnvironment } = await import('../../src/server.js')

  assert.deepEqual(
    configFromEnvironment({
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'account-project',
      STUDENT_INVITATION_BASE_URL: 'https://student.example.test',
      SECURE_DELIVERY_AUTHORITY_BINDING: 'firestore-v1',
      SECURE_DELIVERY_FIREBASE_PROJECT_ID: 'secure-delivery-project',
    }),
    {
      mode: 'production',
      projectId: 'account-project',
      databaseURL: undefined,
      invitationBaseUrl: 'https://student.example.test',
      firebaseAppName: undefined,
      secureDeliveryAuthorityBinding: 'firestore-v1',
      secureDeliveryProjectId: 'secure-delivery-project',
    },
  )

  assert.equal(
    configFromEnvironment({
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'account-project',
      STUDENT_INVITATION_BASE_URL: 'https://student.example.test',
    }).secureDeliveryAuthorityBinding,
    undefined,
  )
})

test('production composition accepts only an explicit firestore-v1 binding and closes its authority Firebase access', async () => {
  const { createStudentAccountService } = await import('../../src/composition.js')
  let closeCalls = 0
  const secureDeliveryFirebaseAdminAccess = {
    getFirestore: () => authorityFirestore(),
    close: async () => { closeCalls += 1 },
  }

  const service = createStudentAccountService({
    config: baseConfig({
      secureDeliveryAuthorityBinding: 'firestore-v1',
      secureDeliveryProjectId: 'secure-delivery-project',
    }),
    adapters: applicationAdapters({ secureDeliveryFirebaseAdminAccess }),
  })

  await service.close()
  await service.close()
  assert.equal(closeCalls, 1)
})

test('unknown production authority binding fails closed', async () => {
  const { createStudentAccountService } = await import('../../src/composition.js')

  assert.throws(
    () => createStudentAccountService({
      config: baseConfig({ secureDeliveryAuthorityBinding: 'unknown' }),
      adapters: applicationAdapters(),
    }),
    /Secure Delivery authority binding/i,
  )
})
