import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

import { createStudentAccount } from '../../src/domain/studentAccount.js'
import { recordStudentSessionService } from '../../src/application/recordStudentSession.js'
import { createStudentAccountRouter } from '../../src/http/router.js'
import { createInMemoryStudentAccountRepository } from '../helpers/inMemoryStudentAccountRepository.js'

function activeAccount({ active = true } = {}) {
  return createStudentAccount({
    studentId: 'student-a',
    firebaseUid: 'firebase-student-a',
    email: 'student@example.com',
    createdAt: '2026-10-07T18:00:00.000Z',
    active,
  })
}

function createUsageRepository() {
  const calls = []
  const seen = new Set()
  let totalSessions = 0
  let lastSessionAt = null
  return {
    calls,
    async recordSessionOnce(input) {
      calls.push(input)
      const key = `${input.studentId}:${input.clientSessionId}`
      const isNew = !seen.has(key)
      if (isNew) {
        seen.add(key)
        totalSessions += 1
        lastSessionAt = input.startedAt
      }
      return Object.freeze({ isNew, totalSessions, lastSessionAt })
    },
  }
}

function createService({ account = activeAccount(), now = '2026-10-08T00:00:00.000Z' } = {}) {
  const usageRepository = createUsageRepository()
  const accounts = createInMemoryStudentAccountRepository(account ? [account] : [])
  const service = recordStudentSessionService({
    tokenVerifier: {
      async verifyIdToken(token) {
        if (token === 'bad-token') throw new Error('secret verifier detail')
        return { uid: 'firebase-student-a', email: 'student@example.com' }
      },
    },
    studentAccountRepository: accounts,
    usageRepository,
    clock: { now: () => now },
  })
  return { service, usageRepository }
}

test('one authenticated app boot increments once and retains the idempotency event for exactly 30 days', async () => {
  const { service, usageRepository } = createService()
  const result = await service.execute({ bearerToken: 'good-token', clientSessionId: 'boot-001' })

  assert.deepEqual(result, {
    isNew: true,
    totalSessions: 1,
    lastSessionAt: '2026-10-08T00:00:00.000Z',
  })
  assert.deepEqual(usageRepository.calls, [{
    studentId: 'student-a',
    clientSessionId: 'boot-001',
    startedAt: '2026-10-08T00:00:00.000Z',
    expiresAt: '2026-11-07T00:00:00.000Z',
  }])
})

test('duplicate clientSessionId is idempotent and different IDs increment independently', async () => {
  const { service } = createService()

  const first = await service.execute({ bearerToken: 'good-token', clientSessionId: 'boot-001' })
  const duplicate = await service.execute({ bearerToken: 'good-token', clientSessionId: 'boot-001' })
  const second = await service.execute({ bearerToken: 'good-token', clientSessionId: 'boot-002' })

  assert.equal(first.isNew, true)
  assert.equal(duplicate.isNew, false)
  assert.equal(duplicate.totalSessions, 1)
  assert.equal(second.isNew, true)
  assert.equal(second.totalSessions, 2)
})

test('missing or inactive student account fails closed', async () => {
  for (const account of [null, activeAccount({ active: false })]) {
    const { service, usageRepository } = createService({ account })
    await assert.rejects(
      service.execute({ bearerToken: 'good-token', clientSessionId: 'boot-001' }),
      /forbidden/i,
    )
    assert.equal(usageRepository.calls.length, 0)
  }
})

test('invalid bearer token fails with bounded unauthorized semantics', async () => {
  const { service, usageRepository } = createService()
  await assert.rejects(
    service.execute({ bearerToken: 'bad-token', clientSessionId: 'boot-001' }),
    (error) => error?.code === 'UNAUTHORIZED' && !error.message.includes('secret verifier detail'),
  )
  assert.equal(usageRepository.calls.length, 0)
})

test('clientSessionId must be a bounded path-safe identifier', async () => {
  for (const clientSessionId of ['', 'a'.repeat(161), 'contains/slash', 'contains space', '\u0000bad']) {
    const { service, usageRepository } = createService()
    await assert.rejects(
      service.execute({ bearerToken: 'good-token', clientSessionId }),
      TypeError,
    )
    assert.equal(usageRepository.calls.length, 0)
  }
})

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

function routerDependencies(recordStudentSession) {
  return {
    tokenVerifier: { async verifyIdToken() { return { uid: 'unused', email: 'unused@example.com' } } },
    teacherIdentityResolver: { async resolveTeacher() { return { teacherId: 'teacher-a', active: true } } },
    createInvitationService: { async execute() { throw new Error('unused') } },
    resolveInvitationService: { async execute() { throw new Error('unused') } },
    revokeInvitationService: { async execute() { throw new Error('unused') } },
    recordStudentSessionService: recordStudentSession,
  }
}

test('student sessions HTTP route forwards only bearer token and clientSessionId and returns bounded usage acknowledgement', async () => {
  const calls = []
  const recordStudentSession = {
    async execute(input) {
      calls.push(input)
      return { isNew: true, totalSessions: 7, lastSessionAt: '2026-10-08T00:00:00.000Z' }
    },
  }

  await withServer(createStudentAccountRouter(routerDependencies(recordStudentSession)), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/student-accounts/v1/student/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ clientSessionId: 'boot-001' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      isNew: true,
      totalSessions: 7,
      lastSessionAt: '2026-10-08T00:00:00.000Z',
    })
    assert.deepEqual(calls, [{ bearerToken: 'session-token', clientSessionId: 'boot-001' }])
  })
})

test('student sessions HTTP route rejects client-supplied studentId', async () => {
  const calls = []
  const recordStudentSession = { async execute(input) { calls.push(input); throw new Error('should-not-run') } }

  await withServer(createStudentAccountRouter(routerDependencies(recordStudentSession)), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/student-accounts/v1/student/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ clientSessionId: 'boot-001', studentId: 'attacker-value' }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' })
    assert.equal(calls.length, 0)
  })
})
