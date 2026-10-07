import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before } from 'node:test'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { get, ref, set } from 'firebase/database'

const PROJECT_ID = 'demo-st-student-account'
const rulesPath = new URL('../../database.rules.json', import.meta.url)
let testEnv

before(async () => {
  let rules
  try {
    rules = fs.readFileSync(rulesPath, 'utf8')
  } catch (error) {
    assert.fail(`database.rules.json must exist: ${error.message}`)
  }
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { rules },
  })
})

after(async () => {
  if (testEnv) await testEnv.cleanup()
})

test('authenticated student may write connection and lastOnlineAt only under own presence uid', async () => {
  const database = testEnv.authenticatedContext('student-a', { role: 'STUDENT' }).database()
  await assertSucceeds(set(ref(database, 'presence/student-a/connections/device-a'), true))
  await assertSucceeds(set(ref(database, 'presence/student-a/lastOnlineAt'), 1791417600000))
  await assertFails(set(ref(database, 'presence/student-b/connections/device-a'), true))
})

test('unauthenticated client cannot write presence', async () => {
  const database = testEnv.unauthenticatedContext().database()
  await assertFails(set(ref(database, 'presence/student-a/connections/device-a'), true))
})

test('normal clients cannot read own or roster-wide presence', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const database = context.database()
    await set(ref(database, 'presence/student-a'), {
      connections: { deviceA: true },
      lastOnlineAt: 1791417600000,
    })
    await set(ref(database, 'presence/student-b'), {
      connections: {},
      lastOnlineAt: 1791417500000,
    })
  })

  const studentDatabase = testEnv.authenticatedContext('student-a', { role: 'STUDENT' }).database()
  const teacherDatabase = testEnv.authenticatedContext('teacher-a', { role: 'TEACHER' }).database()
  await assertFails(get(ref(studentDatabase, 'presence/student-a')))
  await assertFails(get(ref(studentDatabase, 'presence')))
  await assertFails(get(ref(teacherDatabase, 'presence')))
})
