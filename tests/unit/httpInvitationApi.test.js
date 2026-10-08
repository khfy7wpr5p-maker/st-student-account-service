import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

async function loadHttp() {
  try {
    return await import('../../src/http/router.js')
  } catch (error) {
    assert.fail(`http router must load: ${error.message}`)
  }
}

async function withServer(router, fn) {
  const app = express()
  app.use(router)
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function makeDependencies(overrides = {}) {
  const calls = { create: [], resolve: [], revoke: [] }
  const dependencies = {
    tokenVerifier: {
      async verifyIdToken(token) {
        if (token === 'bad-token') throw new Error('raw bad-token must not escape')
        return { uid: 'firebase-teacher-a', email: 'teacher@example.com' }
      },
    },
    teacherIdentityResolver: {
      async resolveTeacher(uid) {
        assert.equal(uid, 'firebase-teacher-a')
        return { teacherId: 'teacher-a', active: true }
      },
    },
    createInvitationService: {
      async execute(input) {
        calls.create.push(input)
        return {
          invitation: {
            inviteId: 'invite-a',
            emailNormalized: input.email.trim().toLowerCase(),
            studentDisplayNameOrNickname: input.displayNameOrNickname,
            expiresAt: '2026-10-14T18:00:00.000Z',
            status: 'PENDING',
          },
          invitationLink: 'https://student.example/#/invite/raw-secret-token',
        }
      },
    },
    resolveInvitationService: {
      async execute(input) {
        calls.resolve.push(input)
        return {
          inviteId: 'invite-a',
          studentDisplayNameOrNickname: 'Ayşe',
          email: 'student@example.com',
          expiresAt: '2026-10-14T18:00:00.000Z',
          accountMode: 'CREATE',
        }
      },
    },
    revokeInvitationService: {
      async execute(input) {
        calls.revoke.push(input)
        return { inviteId: input.inviteId, status: 'REVOKED' }
      },
    },
    ...overrides,
  }
  return { dependencies, calls }
}

async function request(baseUrl, path, { method = 'POST', token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = token
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  return { response, json, text }
}

test('teacher invitation endpoint rejects missing or malformed bearer auth with bounded 401', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const { dependencies } = makeDependencies()
  await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
    for (const token of [undefined, 'Basic abc', 'Bearer', 'Bearer   ']) {
      const { response, json, text } = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
        token,
        body: { email: 'student@example.com', displayNameOrNickname: 'Ayşe' },
      })
      assert.equal(response.status, 401)
      assert.deepEqual(json, { error: 'UNAUTHORIZED' })
      assert.equal(text.includes('abc'), false)
    }
  })
})

test('invalid Firebase token returns bounded 401 without echoing raw token or verifier message', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const { dependencies } = makeDependencies()
  await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
    const { response, text, json } = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
      token: 'Bearer bad-token',
      body: { email: 'student@example.com', displayNameOrNickname: 'Ayşe' },
    })
    assert.equal(response.status, 401)
    assert.deepEqual(json, { error: 'UNAUTHORIZED' })
    assert.equal(text.includes('bad-token'), false)
    assert.equal(text.includes('raw bad-token'), false)
  })
})

test('missing or inactive teacher mapping fails closed with 403', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  for (const mapping of [null, { teacherId: 'teacher-a', active: false }]) {
    const { dependencies } = makeDependencies({
      teacherIdentityResolver: { async resolveTeacher() { return mapping } },
    })
    await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
      const { response, json } = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
        token: 'Bearer good-token',
        body: { email: 'student@example.com', displayNameOrNickname: 'Ayşe' },
      })
      assert.equal(response.status, 403)
      assert.deepEqual(json, { error: 'FORBIDDEN' })
    })
  }
})

test('teacherId is derived from authenticated mapping and client-supplied teacherId is rejected', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const { dependencies, calls } = makeDependencies()
  await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
    const rejected = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
      token: 'Bearer good-token',
      body: { teacherId: 'teacher-attacker', email: 'student@example.com', displayNameOrNickname: 'Ayşe' },
    })
    assert.equal(rejected.response.status, 400)
    assert.deepEqual(rejected.json, { error: 'INVALID_REQUEST' })
    assert.equal(calls.create.length, 0)

    const created = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
      token: 'Bearer good-token',
      body: { email: ' Student@Example.COM ', displayNameOrNickname: 'Ayşe' },
    })
    assert.equal(created.response.status, 201)
    assert.equal(calls.create.length, 1)
    assert.deepEqual(calls.create[0], {
      teacherId: 'teacher-a',
      email: ' Student@Example.COM ',
      displayNameOrNickname: 'Ayşe',
    })
    assert.equal(created.json.inviteId, 'invite-a')
    assert.equal(created.json.invitationLink, 'https://student.example/#/invite/raw-secret-token')
    assert.equal('tokenHash' in created.json, false)
  })
})

test('public resolve accepts invite token only in JSON body and returns bounded activation model', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const { dependencies, calls } = makeDependencies()
  await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
    const resolved = await request(baseUrl, '/api/student-accounts/v1/public/invitations/resolve', {
      body: { inviteToken: 'raw-invite-secret' },
    })
    assert.equal(resolved.response.status, 200)
    assert.deepEqual(calls.resolve, [{ rawToken: 'raw-invite-secret' }])
    assert.equal(resolved.text.includes('raw-invite-secret'), false)
    assert.equal(resolved.json.accountMode, 'CREATE')

    const queryAttempt = await request(baseUrl, '/api/student-accounts/v1/public/invitations/resolve?inviteToken=raw-in-url', {
      body: {},
    })
    assert.equal(queryAttempt.response.status, 400)
    assert.equal(calls.resolve.length, 1)
  })
})

test('teacher revoke endpoint uses authenticated teacher and returns bounded result', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const { dependencies, calls } = makeDependencies()
  await withServer(createStudentAccountRouter(dependencies), async (baseUrl) => {
    const result = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations/invite-a/revoke', {
      token: 'Bearer good-token',
      body: {},
    })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.json, { inviteId: 'invite-a', status: 'REVOKED' })
    assert.deepEqual(calls.revoke, [{ teacherId: 'teacher-a', inviteId: 'invite-a' }])
  })
})

test('known domain conflicts and not-found errors map to bounded 409 and 404 responses', async () => {
  const { createStudentAccountRouter } = await loadHttp()
  const conflict = makeDependencies({
    createInvitationService: { async execute() { throw new Error('pending-invitation-conflict') } },
  }).dependencies
  await withServer(createStudentAccountRouter(conflict), async (baseUrl) => {
    const result = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations', {
      token: 'Bearer good-token',
      body: { email: 'student@example.com', displayNameOrNickname: 'Ayşe' },
    })
    assert.equal(result.response.status, 409)
    assert.deepEqual(result.json, { error: 'CONFLICT' })
  })

  const missing = makeDependencies({
    revokeInvitationService: { async execute() { throw new Error('invitation-not-found') } },
  }).dependencies
  await withServer(createStudentAccountRouter(missing), async (baseUrl) => {
    const result = await request(baseUrl, '/api/student-accounts/v1/teacher/invitations/missing/revoke', {
      token: 'Bearer good-token',
      body: {},
    })
    assert.equal(result.response.status, 404)
    assert.deepEqual(result.json, { error: 'NOT_FOUND' })
  })
})
