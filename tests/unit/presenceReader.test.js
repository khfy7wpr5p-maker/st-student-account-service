import assert from 'node:assert/strict'
import test from 'node:test'

async function loadPresenceModules() {
  try {
    const [{ assertPresenceReader }, { createRealtimePresenceReader }] = await Promise.all([
      import('../../src/ports/presenceReader.js'),
      import('../../src/adapters/firebase/realtimePresenceReader.js'),
    ])
    return { assertPresenceReader, createRealtimePresenceReader }
  } catch (error) {
    assert.fail(`presence modules must load: ${error.message}`)
  }
}

function snapshot(value) {
  return { val: () => value }
}

function createFakeDatabase(sequence) {
  const reads = []
  let index = 0
  return {
    reads,
    value: {
      ref(path) {
        reads.push(path)
        return {
          async once(event) {
            assert.equal(event, 'value')
            const current = sequence[Math.min(index, sequence.length - 1)]
            index += 1
            if (current instanceof Error) throw current
            return snapshot(current)
          },
        }
      },
    },
  }
}

test('PresenceReader port requires getPresenceByFirebaseUid()', async () => {
  const { assertPresenceReader } = await loadPresenceModules()
  assert.throws(() => assertPresenceReader(null), TypeError)
  assert.throws(() => assertPresenceReader({}), TypeError)
  const reader = { async getPresenceByFirebaseUid() {} }
  assert.equal(assertPresenceReader(reader), reader)
})

test('zero connections is OFFLINE and missing lastOnlineAt remains null', async () => {
  const { createRealtimePresenceReader } = await loadPresenceModules()
  const fake = createFakeDatabase([{ connections: {} }])
  const reader = createRealtimePresenceReader({ database: fake.value })

  assert.deepEqual(await reader.getPresenceByFirebaseUid('firebase-student-a'), {
    state: 'OFFLINE',
    lastOnlineAt: null,
  })
  assert.deepEqual(fake.reads, ['presence/firebase-student-a'])
})

test('one or more live connections is ONLINE and server timestamp is normalized to ISO', async () => {
  const { createRealtimePresenceReader } = await loadPresenceModules()
  const fake = createFakeDatabase([{
    connections: { deviceA: true },
    lastOnlineAt: Date.parse('2026-10-08T00:00:00.000Z'),
  }])
  const reader = createRealtimePresenceReader({ database: fake.value })

  assert.deepEqual(await reader.getPresenceByFirebaseUid('firebase-student-a'), {
    state: 'ONLINE',
    lastOnlineAt: '2026-10-08T00:00:00.000Z',
  })
})

test('multiple devices remain ONLINE until the final connection disappears', async () => {
  const { createRealtimePresenceReader } = await loadPresenceModules()
  const fake = createFakeDatabase([
    { connections: { deviceA: true, deviceB: true } },
    { connections: { deviceB: true } },
    { connections: {} },
  ])
  const reader = createRealtimePresenceReader({ database: fake.value })

  assert.equal((await reader.getPresenceByFirebaseUid('firebase-student-a')).state, 'ONLINE')
  assert.equal((await reader.getPresenceByFirebaseUid('firebase-student-a')).state, 'ONLINE')
  assert.equal((await reader.getPresenceByFirebaseUid('firebase-student-a')).state, 'OFFLINE')
})

test('backend read failure becomes UNKNOWN instead of OFFLINE', async () => {
  const { createRealtimePresenceReader } = await loadPresenceModules()
  const fake = createFakeDatabase([new Error('database-unavailable')])
  const reader = createRealtimePresenceReader({ database: fake.value })

  assert.deepEqual(await reader.getPresenceByFirebaseUid('firebase-student-a'), {
    state: 'UNKNOWN',
    lastOnlineAt: null,
  })
})

test('firebase uid is bounded and path-safe before database access', async () => {
  const { createRealtimePresenceReader } = await loadPresenceModules()
  const fake = createFakeDatabase([null])
  const reader = createRealtimePresenceReader({ database: fake.value })

  for (const uid of ['', '   ', 'bad/uid', 'bad.uid', 'bad#uid', 'bad$uid', 'bad[uid]', 'bad]uid']) {
    await assert.rejects(() => reader.getPresenceByFirebaseUid(uid), TypeError)
  }
  assert.equal(fake.reads.length, 0)
})
