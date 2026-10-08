import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

import { createStudentAccountRouter } from '../../src/http/router.js'

async function withServer(router, fn) {
  const app = express()
  app.use(router)
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function dependencies() {
  const calls = []
  return {
    calls,
    value: {
      tokenVerifier: {
        async verifyIdToken(token) {
          if (token === 'bad-token') throw new Error('raw bad-token')
          return { uid: 'firebase-student-a', email: 'student@example.com' }
        },
      },
      teacherIdentityResolver: { async resolveTeacher() { return { teacherId: 'teacher-a', active: true } } },
      createInvitationService: { async execute() { throw new Error('unused') } },
      resolveInvitationService: { async execute() { throw new Error('unused') } },
      revokeInvitationService: { async execute() { throw new Error('unused') } },
      acceptInvitationService: {
        async execute(input) {
          calls.push(input)
          return { studentId: 'student-a', relationshipState: 'ACTIVE', invitation: { status: 'ACCEPTED' } }
        },
      },
    },
  }
}

async function post(baseUrl, options = {}) {
  const token = Object.prototype.hasOwnProperty.call(options, 'token')
    ? options.token
    : 'Bearer good-token'
  const body = Object.prototype.hasOwnProperty.call(options, 'body')
    ? options.body
    : { inviteToken: 'raw-invite-secret' }
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = token
  const response = await fetch(`${baseUrl}/api/student-accounts/v1/student/invitations/accept`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { response, text, json }
}

test('student activation endpoint derives authenticated user from Firebase token and never accepts client identity authority', async () => {
  const { value, calls } = dependencies()
  await withServer(createStudentAccountRouter(value), async (baseUrl) => {
    const result = await post(baseUrl)
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.json, { studentId: 'student-a', relationshipState: 'ACTIVE' })
    assert.deepEqual(calls, [{
      rawToken: 'raw-invite-secret',
      authenticatedUser: { uid: 'firebase-student-a', email: 'student@example.com' },
    }])
    assert.equal(result.text.includes('raw-invite-secret'), false)
    assert.equal(result.text.includes('firebase-student-a'), false)
  })
})

test('student activation endpoint rejects client-supplied uid, email, studentId, or teacherId', async () => {
  const forbiddenFields = ['uid', 'email', 'studentId', 'teacherId']
  for (const field of forbiddenFields) {
    const { value, calls } = dependencies()
    await withServer(createStudentAccountRouter(value), async (baseUrl) => {
      const result = await post(baseUrl, { body: { inviteToken: 'raw-invite-secret', [field]: 'attacker-value' } })
      assert.equal(result.response.status, 400)
      assert.deepEqual(result.json, { error: 'INVALID_REQUEST' })
      assert.equal(calls.length, 0)
    })
  }
})

test('student activation endpoint fails invalid or missing bearer auth with bounded 401', async () => {
  for (const token of [undefined, 'Bearer bad-token', 'Basic abc']) {
    const { value, calls } = dependencies()
    await withServer(createStudentAccountRouter(value), async (baseUrl) => {
      const result = await post(baseUrl, { token })
      assert.equal(result.response.status, 401)
      assert.deepEqual(result.json, { error: 'UNAUTHORIZED' })
      assert.equal(result.text.includes('bad-token'), false)
      assert.equal(calls.length, 0)
    })
  }
})
