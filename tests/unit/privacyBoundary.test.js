import assert from 'node:assert/strict'
import test from 'node:test'

async function loadBoundaries() {
  try {
    const [tokenVerifier, authDirectory, firebaseAdmin, bearer, errors] = await Promise.all([
      import('../../src/adapters/firebase/firebaseTokenVerifier.js'),
      import('../../src/adapters/firebase/firebaseAuthDirectory.js'),
      import('../../src/adapters/firebase/firebaseAdmin.js'),
      import('../../src/http/bearerToken.js'),
      import('../../src/http/errorResponse.js'),
    ])
    return { tokenVerifier, authDirectory, firebaseAdmin, bearer, errors }
  } catch (error) {
    assert.fail(`privacy boundary modules must load: ${error.message}`)
  }
}

test('Firebase token verifier exposes only uid and email from decoded claims', async () => {
  const { tokenVerifier } = await loadBoundaries()
  const auth = {
    async verifyIdToken(token) {
      assert.equal(token, 'token-a')
      return { uid: 'firebase-uid-a', email: 'Student@Example.com', admin: true, secretClaim: 'do-not-expose' }
    },
  }
  const verifier = tokenVerifier.createFirebaseTokenVerifier({ auth })
  const result = await verifier.verifyIdToken('token-a')
  assert.deepEqual(result, { uid: 'firebase-uid-a', email: 'student@example.com' })
  assert.equal(Object.isFrozen(result), true)
  assert.equal('admin' in result, false)
  assert.equal('secretClaim' in result, false)
})

test('Firebase token verifier rejects decoded tokens without a usable uid or email', async () => {
  const { tokenVerifier } = await loadBoundaries()
  for (const decoded of [{ email: 'a@example.com' }, { uid: 'uid-a' }, { uid: 'uid-a', email: '' }]) {
    const verifier = tokenVerifier.createFirebaseTokenVerifier({ auth: { async verifyIdToken() { return decoded } } })
    await assert.rejects(verifier.verifyIdToken('token-a'), /identity|email|uid/i)
  }
})

test('Firebase auth directory maps only auth/user-not-found to false and rethrows other failures', async () => {
  const { authDirectory } = await loadBoundaries()
  const found = authDirectory.createFirebaseAuthDirectory({
    auth: { async getUserByEmail(email) { assert.equal(email, 'student@example.com'); return { uid: 'uid-a' } } },
  })
  assert.equal(await found.accountExistsByEmail('student@example.com'), true)

  const missing = authDirectory.createFirebaseAuthDirectory({
    auth: { async getUserByEmail() { const error = new Error('not found'); error.code = 'auth/user-not-found'; throw error } },
  })
  assert.equal(await missing.accountExistsByEmail('student@example.com'), false)

  const outage = new Error('upstream-secret-details')
  outage.code = 'auth/internal-error'
  const broken = authDirectory.createFirebaseAuthDirectory({ auth: { async getUserByEmail() { throw outage } } })
  await assert.rejects(broken.accountExistsByEmail('student@example.com'), (error) => error === outage)
})

test('Firebase Admin access is lazy and emulator mode does not require production credentials', async () => {
  const { firebaseAdmin } = await loadBoundaries()
  let appCalls = 0
  let authCalls = 0
  const access = firebaseAdmin.createFirebaseAdminAccess({
    projectId: 'demo-st-student-account',
    emulator: true,
    appFactory(options, appName) {
      appCalls += 1
      assert.equal(options.projectId, 'demo-st-student-account')
      assert.equal('credential' in options, false)
      assert.equal(appName, 'st-student-account-service')
      return { name: appName }
    },
    authFactory(app) {
      authCalls += 1
      return { app }
    },
  })

  assert.equal(appCalls, 0)
  assert.equal(authCalls, 0)
  const first = access.getAuth()
  const second = access.getAuth()
  assert.equal(first, second)
  assert.equal(appCalls, 1)
  assert.equal(authCalls, 1)
})

test('bearer parser accepts one Bearer token and never includes credentials in errors', async () => {
  const { bearer } = await loadBoundaries()
  assert.equal(bearer.readBearerToken({ headers: { authorization: 'Bearer token-a' } }), 'token-a')
  for (const authorization of [undefined, 'Basic abc-secret', 'Bearer', 'Bearer a b']) {
    assert.throws(
      () => bearer.readBearerToken({ headers: { authorization } }),
      (error) => {
        assert.equal(String(error.message).includes('abc-secret'), false)
        assert.equal(String(error.message).includes('a b'), false)
        return true
      },
    )
  }
})

test('HTTP error mapper emits bounded public errors and never forwards internal messages', async () => {
  const { errors } = await loadBoundaries()
  const cases = [
    [Object.assign(new Error('token-is-secret'), { code: 'UNAUTHORIZED' }), 401, 'UNAUTHORIZED'],
    [Object.assign(new Error('uid-is-private'), { code: 'FORBIDDEN' }), 403, 'FORBIDDEN'],
    [new Error('invitation-not-found'), 404, 'NOT_FOUND'],
    [new Error('pending-invitation-conflict'), 409, 'CONFLICT'],
    [new TypeError('raw-invite-secret'), 400, 'INVALID_REQUEST'],
    [new Error('service-account-private-key'), 500, 'INTERNAL_ERROR'],
  ]
  for (const [error, status, publicCode] of cases) {
    const result = errors.toHttpError(error)
    assert.deepEqual(result, { status, body: { error: publicCode } })
    assert.equal(JSON.stringify(result).includes(error.message), false)
  }
})
