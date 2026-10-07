import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before } from 'node:test'
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

const PROJECT_ID = 'demo-st-student-account'
const rulesPath = new URL('../../firestore.rules', import.meta.url)
let testEnv

before(async () => {
  let rules
  try {
    rules = fs.readFileSync(rulesPath, 'utf8')
  } catch (error) {
    assert.fail(`firestore.rules must exist: ${error.message}`)
  }
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules },
  })
})

after(async () => {
  if (testEnv) await testEnv.cleanup()
})

const PRIVATE_COLLECTIONS = [
  'studentInvitations',
  'studentInvitationPendingLocks',
  'studentAccounts',
  'studentAccountUidMappings',
  'teacherStudentRelationships',
  'teacherStudentRelationshipSources',
]

async function assertPrivateForContext(context) {
  const firestore = context.firestore()
  for (const collectionName of PRIVATE_COLLECTIONS) {
    const reference = doc(firestore, collectionName, 'probe')
    await assertFails(getDoc(reference))
    await assertFails(setDoc(reference, { probe: true }))
  }
}

test('unauthenticated browser clients cannot read or write account-service private collections', async () => {
  await assertPrivateForContext(testEnv.unauthenticatedContext())
})

test('authenticated student browser clients cannot read or write account-service private collections', async () => {
  await assertPrivateForContext(testEnv.authenticatedContext('student-browser', { role: 'STUDENT' }))
})

test('authenticated teacher browser clients cannot read or write account-service private collections', async () => {
  await assertPrivateForContext(testEnv.authenticatedContext('teacher-browser', { role: 'TEACHER' }))
})
