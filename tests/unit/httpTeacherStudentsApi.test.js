import assert from 'node:assert/strict'
import test from 'node:test'

import { createStudentAccountRouter } from '../../src/http/router.js'

function baseDependencies(overrides = {}) {
  const calls = []
  return {
    calls,
    value: {
      tokenVerifier: {
        async verifyIdToken(token) {
          assert.equal(token, 'teacher-token')
          return { uid: 'firebase-teacher-a', email: 'teacher@example.com' }
        },
      },
      teacherIdentityResolver: {
        async resolveTeacher(uid) {
          assert.equal(uid, 'firebase-teacher-a')
          return { teacherId: 'teacher-a', active: true }
        },
      },
      createInvitationService: { async execute() { throw new Error('unused') } },
      resolveInvitationService: { async execute() { throw new Error('unused') } },
      revokeInvitationService: { async execute() { throw new Error('unused') } },
      listTeacherStudentsService: {
        async execute(input) {
          calls.push(input)
          return [{
            managementId: 'invite-a', studentId: 'student-a', displayNameOrNickname: 'Ayşe',
            state: 'ACTIVE', invitationStatus: 'ACCEPTED', presenceState: 'ONLINE',
            lastOnlineAt: '2026-10-08T00:10:00.000Z', lastSessionAt: '2026-10-08T00:00:00.000Z',
            totalSessions: 7,
          }]
        },
      },
      ...overrides,
    },
  }
}

async function startServer(dependencies) {
  const express = (await import('express')).default
  const app = express()
  app.use(createStudentAccountRouter(dependencies))
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

test('teacher students endpoint derives teacherId from verified identity and returns bounded rows', async () => {
  const dependencies = baseDependencies()
  const server = await startServer(dependencies.value)
  try {
    const response = await fetch(`${server.url}/api/student-accounts/v1/teacher/students?teacherId=teacher-b`, {
      headers: { authorization: 'Bearer teacher-token' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { students: [{
      managementId: 'invite-a', studentId: 'student-a', displayNameOrNickname: 'Ayşe',
      state: 'ACTIVE', invitationStatus: 'ACCEPTED', presenceState: 'ONLINE',
      lastOnlineAt: '2026-10-08T00:10:00.000Z', lastSessionAt: '2026-10-08T00:00:00.000Z',
      totalSessions: 7,
    }] })
    assert.deepEqual(dependencies.calls, [{ teacherId: 'teacher-a' }])
  } finally {
    await server.close()
  }
})

test('teacher students endpoint keeps authentication failures bounded', async () => {
  const dependencies = baseDependencies({
    tokenVerifier: { async verifyIdToken() { throw new Error('raw-provider-secret') } },
  })
  const server = await startServer(dependencies.value)
  try {
    const response = await fetch(`${server.url}/api/student-accounts/v1/teacher/students`, {
      headers: { authorization: 'Bearer invalid-secret-token' },
    })
    assert.equal(response.status, 401)
    const body = await response.text()
    assert.equal(body.includes('invalid-secret-token'), false)
    assert.equal(body.includes('raw-provider-secret'), false)
    assert.deepEqual(JSON.parse(body), { error: 'UNAUTHORIZED' })
  } finally {
    await server.close()
  }
})
