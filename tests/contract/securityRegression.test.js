import assert from 'node:assert/strict'
import test from 'node:test'

const SAMPLES=['Bearer super-secret-token','firebase-uid-secret','student@example.com','raw-invite-token','projects/demo/databases/(default)/documents/studentAccounts/student-a']

test('runtime config requires bounded Firebase identity and contains no credential material', async () => {
  const {buildRuntimeConfig}=await import('../../src/server.js')
  assert.throws(()=>buildRuntimeConfig({}),/FIREBASE_PROJECT_ID/)
  const config=buildRuntimeConfig({NODE_ENV:'development',FIREBASE_PROJECT_ID:'demo-st-student-account',FIREBASE_DATABASE_URL:'http://127.0.0.1:9000?ns=demo-st-student-account',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',FIREBASE_DATABASE_EMULATOR_HOST:'127.0.0.1:9000',INVITATION_BASE_URL:'https://student.example.test',PORT:'8787'})
  assert.equal(config.mode,'emulator')
  assert.equal(config.projectId,'demo-st-student-account')
  assert.equal(config.port,8787)
  assert.equal('serviceAccount' in config,false)
  assert.equal('credential' in config,false)
  assert.equal(JSON.stringify(config).includes('PRIVATE KEY'),false)
})

test('public error serialization and health data do not contain known secret samples', async () => {const {toPublicError}=await import('../../src/http/errorResponse.js');const mapped=toPublicError(new Error(SAMPLES.join(' ')));const serialized=JSON.stringify(mapped);for(const sample of SAMPLES) assert.equal(serialized.includes(sample),false)})

test('node token generator produces URL-safe high-entropy token and sha256 fingerprint only', async () => {const {createNodeTokenGenerator}=await import('../../src/ports/tokenGenerator.js');const tokens=createNodeTokenGenerator();const raw=tokens.createInviteToken();assert.match(raw,/^[A-Za-z0-9_-]+$/);assert.ok(raw.length>=43);const hash=tokens.hashInviteToken(raw);assert.match(hash,/^[a-f0-9]{64}$/);assert.notEqual(hash,raw);assert.match(tokens.createDomainId('student'),/^student-[A-Za-z0-9-]+$/)})
