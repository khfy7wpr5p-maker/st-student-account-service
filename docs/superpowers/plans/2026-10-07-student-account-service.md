# ST Student Account Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone `st-student-account-service` V1 for invitation links, teacher/student relationship activation, privacy-minimized usage counting, presence readout, and a teacher-scoped student-management read model without changing ST Student or SesliTab production code until a later human-approved integration stage.

**Architecture:** Keep domain/application logic provider-neutral behind explicit ports. Persist account-service-owned records in Firestore, use Firebase Realtime Database for connection presence, verify Firebase identities server-side, and bind assignment authority only through a `SecureDeliveryAuthorityPort`; the production Secure Delivery adapter is deliberately excluded from this plan. The service must remain fail-closed, idempotent, and privacy-minimized.

**Tech Stack:** Node.js 24, ECMAScript modules, Express 4.21.x, Firebase Admin SDK 14.4.x, Firebase JS SDK 12.19.x for emulator/rules clients, Cloud Firestore, Firebase Realtime Database, `node:crypto`, `node:test`, `@firebase/rules-unit-testing` 5.0.2, Firebase CLI 15.32.x.

**Spec:** `docs/superpowers/specs/2026-10-07-student-account-service-design.md`

## Global Constraints

- Existing ST Student email/password login remains unchanged in this plan.
- No write to `st-student-app` or `seslitab-guitar-reader` is authorized by this plan.
- Firebase UID is not `studentId` or `teacherId`; stable SesliTab IDs remain domain authority.
- Existing Secure Delivery identity/grant collections remain owned by Secure Delivery and are reached only through `SecureDeliveryAuthorityPort`.
- No production implementation/activation of `SecureDeliveryAuthorityPort` in this plan.
- Passwords never enter this service.
- Raw Firebase ID tokens, raw invitation tokens, service-account material, Firebase UIDs, IP/device/location data, and internal Firestore paths must not appear in normal logs or public responses.
- Invitation lifetime is exactly seven days.
- Raw invitation tokens are returned once at creation and only `SHA-256(rawToken)` is persisted.
- One live `PENDING` invitation per `teacherId + emailNormalized` pair.
- Usage session idempotency retention is 30 days; production TTL deployment is a later human gate.
- Presence is informational only and may never authorize assignments.
- `UNKNOWN` presence is distinct from `OFFLINE`.
- Direct browser access to service-owned private Firestore collections is denied; only self-presence RTDB writes are allowed from clients.
- No new Render/Vercel/Firebase hosting service, production Firebase change, secret addition, deployment, merge, or migration without a separate explicit human gate.
- Use TDD, smallest coherent changes, focused commits, and fresh verification evidence.

## Review Focus

1. **Invite token replay / collision:** an accepted, revoked, expired, or ambiguous token must fail closed and never create a second relationship. Covered in Tasks 2, 4, and 5.
2. **Cross-identity activation:** a valid invite presented by a Firebase account with a different normalized email or conflicting stable identity must fail without consuming the invite. Covered in Task 4.
3. **Partial authority activation:** Secure Delivery acknowledgement succeeds but local finalization fails, or vice versa; retry must converge safely without duplicate IDs/grants and must not expose the student as ACTIVE early. Covered in Task 4.
4. **Presence ambiguity:** RTDB read failure, stale/missing connection children, and multiple devices must map to `UNKNOWN`/`OFFLINE`/`ONLINE` correctly without changing authorization. Covered in Task 7.
5. **Usage duplicate/retry:** duplicate `clientSessionId`, network retry, and concurrent submissions must increment `totalSessions` at most once. Covered in Tasks 6 and 8.

---

## Locked File Structure

```text
package.json
firebase.json
firestore.rules
firestore.indexes.json
database.rules.json

src/
  domain/
    validation.js
    studentInvitation.js
    studentAccount.js
    teacherStudentRelationship.js
    studentUsage.js

  application/
    createInvitation.js
    resolveInvitation.js
    acceptInvitation.js
    revokeInvitation.js
    listTeacherStudents.js
    recordStudentSession.js

  ports/
    tokenVerifier.js
    teacherIdentityResolver.js
    authDirectory.js
    invitationRepository.js
    studentAccountRepository.js
    relationshipRepository.js
    usageRepository.js
    presenceReader.js
    secureDeliveryAuthorityPort.js
    clock.js
    tokenGenerator.js

  adapters/
    firebase/
      firebaseAdmin.js
      firebaseTokenVerifier.js
      firebaseAuthDirectory.js
      firestoreInvitationRepository.js
      firestoreStudentAccountRepository.js
      firestoreRelationshipRepository.js
      firestoreUsageRepository.js
      realtimePresenceReader.js

  http/
    bearerToken.js
    errorResponse.js
    router.js

  composition.js
  server.js

tests/
  helpers/
  unit/
  contract/
  emulator/

docs/
  superpowers/
    specs/
    plans/
```

`authDirectory.js` is the narrow technical port used only to answer whether an invitation email already has a Firebase Auth account. It does not grant authority and does not expose credentials.

---

### Task 1: Repository foundation and immutable domain records

**Files:**
- Create: `package.json`
- Create: `src/domain/validation.js`
- Create: `src/domain/studentInvitation.js`
- Create: `src/domain/studentAccount.js`
- Create: `src/domain/teacherStudentRelationship.js`
- Create: `src/domain/studentUsage.js`
- Create: `src/ports/clock.js`
- Create: `src/ports/tokenGenerator.js`
- Test: `tests/unit/domainContracts.test.js`

**Interfaces:**
- Produces `createStudentInvitation(input)`, `acceptStudentInvitation(record, { studentId, acceptedAt })`, `revokeStudentInvitation(record, revokedAt)`, `expireStudentInvitation(record, expiredAt)`.
- Produces `createStudentAccount(input)` and immutable `StudentAccount` v1.
- Produces `createTeacherStudentRelationship(input)` plus activation/deactivation helpers.
- Produces `createStudentUsageSummary(input)` and `createStudentUsageSession(input)`.
- Produces `assertClock(clock)` with `clock.now() -> ISO timestamp` and `assertTokenGenerator(generator)` with `createInviteToken()`, `hashInviteToken(rawToken)`, `createDomainId(prefix)`.

- [ ] **Step 1: Add RED domain-contract tests**

Pin exact schema versions, strict field sets, seven-day invitation expiry, allowed invitation states, immutable records, normalized lowercase email, non-negative usage counters, and no credential/provider fields.

Representative assertions:

```js
assert.equal(invitation.status, 'PENDING')
assert.equal(invitation.expiresAt, '2026-10-14T18:00:00.000Z')
assert.equal(Object.isFrozen(invitation), true)
assert.equal('password' in invitation, false)
assert.equal(account.studentId, 'student-a')
assert.equal(usage.totalSessions, 0)
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/domainContracts.test.js`

Expected: FAIL because domain modules do not exist.

- [ ] **Step 3: Implement the minimal strict constructors and state transitions**

Use plain frozen records, strict unknown-field rejection, ISO timestamps, bounded text/ID validation, and built-in `node:crypto` only through the injected token generator implementation prepared for later composition.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/unit/domainContracts.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/domain src/ports/clock.js src/ports/tokenGenerator.js tests/unit/domainContracts.test.js
git commit -m "feat: define student account domain contracts"
```

---

### Task 2: Invitation repositories and invitation lifecycle application services

**Files:**
- Create: `src/ports/invitationRepository.js`
- Create: `src/ports/authDirectory.js`
- Create: `src/application/createInvitation.js`
- Create: `src/application/resolveInvitation.js`
- Create: `src/application/revokeInvitation.js`
- Create: `tests/helpers/inMemoryInvitationRepository.js`
- Test: `tests/unit/invitationApplication.test.js`

**Interfaces:**
- `InvitationRepository.create(record) -> Promise<StudentInvitation>`
- `InvitationRepository.findPendingByTeacherAndEmail(teacherId, emailNormalized) -> Promise<StudentInvitation|null>`
- `InvitationRepository.findByTokenHash(tokenHash) -> Promise<StudentInvitation|null>`
- `InvitationRepository.getById(inviteId) -> Promise<StudentInvitation|null>`
- `InvitationRepository.replace(expectedRecord, nextRecord) -> Promise<StudentInvitation>` with optimistic conflict detection.
- `AuthDirectory.accountExistsByEmail(emailNormalized) -> Promise<boolean>`.
- `createInvitationService({ repository, clock, tokenGenerator, invitationBaseUrl })` exposes `execute({ teacherId, email, displayNameOrNickname })` and returns `{ invitation, invitationLink }` exactly once.
- `resolveInvitationService({ repository, authDirectory, clock, tokenGenerator })` exposes `execute({ rawToken })` and returns the bounded activation display model.
- `revokeInvitationService({ repository, clock })` exposes `execute({ teacherId, inviteId })`.

- [ ] **Step 1: Add RED invitation lifecycle tests**

Cover: one live pending invite per teacher+email, seven-day expiry, raw token absent from repository snapshots, token hash lookup, accountMode `CREATE|SIGN_IN`, wrong teacher revoke rejection, accepted/revoked/expired token resolution rejection, and a token hash lookup returning more than one logical match as fail-closed in reference tests.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/invitationApplication.test.js`

Expected: FAIL because ports/services do not exist.

- [ ] **Step 3: Implement invitation services with raw-token confinement**

`createInvitation` may keep the raw token only in function-local memory long enough to build the one-time response. Repositories receive only `tokenHash`. `resolveInvitation` must expire stale pending invitations through a compare-and-replace before returning an activation model.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/unit/invitationApplication.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/invitationRepository.js src/ports/authDirectory.js src/application/createInvitation.js src/application/resolveInvitation.js src/application/revokeInvitation.js tests/helpers/inMemoryInvitationRepository.js tests/unit/invitationApplication.test.js
git commit -m "feat: add invitation lifecycle services"
```

---

### Task 3: Firebase token verification, teacher identity boundary, and HTTP invitation endpoints

**Files:**
- Create: `src/ports/tokenVerifier.js`
- Create: `src/ports/teacherIdentityResolver.js`
- Create: `src/adapters/firebase/firebaseAdmin.js`
- Create: `src/adapters/firebase/firebaseTokenVerifier.js`
- Create: `src/adapters/firebase/firebaseAuthDirectory.js`
- Create: `src/http/bearerToken.js`
- Create: `src/http/errorResponse.js`
- Create: `src/http/router.js`
- Test: `tests/unit/httpInvitationApi.test.js`
- Test: `tests/unit/privacyBoundary.test.js`

**Interfaces:**
- `TokenVerifier.verifyIdToken(token) -> Promise<{ uid, email }>`.
- `TeacherIdentityResolver.resolveTeacher(firebaseUid) -> Promise<{ teacherId, active } | null>`.
- `FirebaseAuthDirectory.accountExistsByEmail(emailNormalized) -> Promise<boolean>`; only user-not-found maps to `false`.
- HTTP routes introduced in this task:
  - `POST /api/student-accounts/v1/teacher/invitations`
  - `POST /api/student-accounts/v1/public/invitations/resolve`
  - `POST /api/student-accounts/v1/teacher/invitations/:inviteId/revoke`
- Teacher routes derive `teacherId` exclusively from verified Firebase identity + `TeacherIdentityResolver`.

- [ ] **Step 1: Add RED HTTP/auth tests**

Cover missing/malformed bearer token, invalid token, disabled/missing teacher mapping, client-supplied `teacherId` ignored/rejected, bounded 401/403/404/409 errors, create response containing invitation link once, public resolve accepting the raw token only in JSON body, and response/log sanitization.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/httpInvitationApi.test.js tests/unit/privacyBoundary.test.js`

Expected: FAIL because HTTP/auth modules do not exist.

- [ ] **Step 3: Implement isolated Express router and Firebase adapters**

No request body or error response may echo bearer tokens or invite tokens. `firebaseAdmin.js` must initialize lazily and support emulator configuration without embedded credentials.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/unit/httpInvitationApi.test.js tests/unit/privacyBoundary.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/tokenVerifier.js src/ports/teacherIdentityResolver.js src/adapters/firebase/firebaseAdmin.js src/adapters/firebase/firebaseTokenVerifier.js src/adapters/firebase/firebaseAuthDirectory.js src/http tests/unit/httpInvitationApi.test.js tests/unit/privacyBoundary.test.js
git commit -m "feat: add authenticated invitation HTTP boundary"
```

---

### Task 4: Student activation orchestration and Secure Delivery authority port

**Files:**
- Create: `src/ports/studentAccountRepository.js`
- Create: `src/ports/relationshipRepository.js`
- Create: `src/ports/secureDeliveryAuthorityPort.js`
- Create: `src/application/acceptInvitation.js`
- Create: `tests/helpers/inMemoryStudentAccountRepository.js`
- Create: `tests/helpers/inMemoryRelationshipRepository.js`
- Create: `tests/helpers/fakeSecureDeliveryAuthorityPort.js`
- Test: `tests/unit/acceptInvitation.test.js`
- Modify: `src/http/router.js`
- Test: `tests/unit/httpStudentActivationApi.test.js`

**Interfaces:**
- `StudentAccountRepository.findByFirebaseUid(uid) -> Promise<StudentAccount|null>`.
- `StudentAccountRepository.createActivating(record) -> Promise<StudentAccount>` and exact-idempotent reread semantics.
- `RelationshipRepository.beginActivation(record)`, `markActive(relationshipId, activatedAt)`, `getBySourceInviteId(inviteId)`.
- `SecureDeliveryAuthorityPort.activateStudent({ firebaseUid, teacherId, studentId, activatedAt, sourceInviteId }) -> Promise<{ studentId, teacherId, identityActive, grantActive }>`; same exact call must be idempotent.
- `acceptInvitationService(...).execute({ rawToken, authenticatedUser: { uid, email } })`.
- HTTP route: `POST /api/student-accounts/v1/student/invitations/accept`.

- [ ] **Step 1: Add RED activation tests**

Cover exact email match, email mismatch, conflicting Firebase UID→student identity, existing account reuse for a second teacher invitation, first-time stable student ID creation, accepted/revoked/expired invite rejection, authority ack mismatch, authority failure leaving public state non-ACTIVE, local finalize failure after authority success followed by safe retry, and concurrent duplicate accept converging to one student/relationship.

Representative final assertions:

```js
assert.equal(result.relationshipState, 'ACTIVE')
assert.equal(result.studentId, 'student-a')
assert.equal(authority.calls.length, 1)
assert.equal(invitation.status, 'ACCEPTED')
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/acceptInvitation.test.js tests/unit/httpStudentActivationApi.test.js`

Expected: FAIL because activation modules do not exist.

- [ ] **Step 3: Implement retry-safe activation state machine**

Use local `ACTIVATING` staging before the external authority call. Never publish roster `active=true` until exact authority acknowledgement is verified and local finalization commits. Retries must reuse the same stable `studentId` and source invite relationship.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/unit/acceptInvitation.test.js tests/unit/httpStudentActivationApi.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/studentAccountRepository.js src/ports/relationshipRepository.js src/ports/secureDeliveryAuthorityPort.js src/application/acceptInvitation.js src/http/router.js tests/helpers tests/unit/acceptInvitation.test.js tests/unit/httpStudentActivationApi.test.js
git commit -m "feat: add retry-safe student invitation activation"
```

---

### Task 5: Firestore persistence and private Firestore security rules

**Files:**
- Create: `src/adapters/firebase/firestoreInvitationRepository.js`
- Create: `src/adapters/firebase/firestoreStudentAccountRepository.js`
- Create: `src/adapters/firebase/firestoreRelationshipRepository.js`
- Create: `firestore.rules`
- Create: `firestore.indexes.json`
- Create: `firebase.json`
- Test: `tests/emulator/firestoreRepositories.test.js`
- Test: `tests/emulator/firestoreRules.test.js`

**Interfaces:**
- Firebase adapters implement the Task 2/4 repository ports exactly.
- Logical service-owned collections:
  - `studentInvitations`
  - `studentAccounts`
  - `teacherStudentRelationships`
- Existing Secure Delivery collections such as `identityMappings` and `teacherStudentGrants` are not created, migrated, or written by these adapters.

- [ ] **Step 1: Add RED emulator tests**

Prove unique pending invitation behavior, compare-and-replace conflicts, token-hash lookup, activation retry persistence, no duplicate student account for one UID, no duplicate relationship for one source invite, and direct unauthenticated/student/teacher browser Firestore read/write denial for all private account-service collections.

- [ ] **Step 2: Run emulator tests and confirm RED**

Run:

```bash
firebase emulators:exec --project demo-st-student-account --only auth,firestore "node --test tests/emulator/firestoreRepositories.test.js tests/emulator/firestoreRules.test.js"
```

Expected: FAIL because adapters/rules do not exist.

- [ ] **Step 3: Implement Firestore adapters with transactions/preconditions**

Use server timestamps where the domain contract expects server-owned time at persistence boundaries, but convert to stable ISO strings before exposing provider-neutral records. Do not expose DocumentReference or provider timestamp objects through ports.

- [ ] **Step 4: Run emulator tests and verify GREEN**

Run the same emulator command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/firebase/firestore* firebase.json firestore.rules firestore.indexes.json tests/emulator/firestoreRepositories.test.js tests/emulator/firestoreRules.test.js
git commit -m "feat: persist student account records in firestore"
```

---

### Task 6: Idempotent usage-session counter

**Files:**
- Create: `src/ports/usageRepository.js`
- Create: `src/application/recordStudentSession.js`
- Create: `src/adapters/firebase/firestoreUsageRepository.js`
- Modify: `src/http/router.js`
- Test: `tests/unit/recordStudentSession.test.js`
- Test: `tests/emulator/firestoreUsage.test.js`

**Interfaces:**
- `UsageRepository.recordSessionOnce({ studentId, clientSessionId, startedAt, expiresAt }) -> Promise<{ isNew, totalSessions, lastSessionAt }>`.
- `recordStudentSessionService({ tokenVerifier, studentAccountRepository, usageRepository, clock }).execute({ bearerToken, clientSessionId })` resolves the stable student from verified UID; client never sends `studentId`.
- HTTP route: `POST /api/student-accounts/v1/student/sessions`.

- [ ] **Step 1: Add RED unit/emulator tests**

Cover one boot increments once, duplicate ID is idempotent, concurrent duplicate submissions increment once, different IDs increment independently, disabled/missing account fails closed, invalid/bounds-breaking session ID fails, and `expiresAt` is exactly 30 days after `startedAt`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/recordStudentSession.test.js`

Then emulator: `firebase emulators:exec --project demo-st-student-account --only firestore "node --test tests/emulator/firestoreUsage.test.js"`

Expected: FAIL because usage modules do not exist.

- [ ] **Step 3: Implement transactional idempotent usage persistence**

Logical paths may be `studentUsage/{studentId}` and `studentUsage/{studentId}/sessions/{clientSessionId}`. The domain/application layer must not depend on these physical paths.

- [ ] **Step 4: Run focused + emulator tests and verify GREEN**

Run both commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/usageRepository.js src/application/recordStudentSession.js src/adapters/firebase/firestoreUsageRepository.js src/http/router.js tests/unit/recordStudentSession.test.js tests/emulator/firestoreUsage.test.js
git commit -m "feat: add idempotent student usage sessions"
```

---

### Task 7: Realtime Database presence read model and self-presence rules

**Files:**
- Create: `src/ports/presenceReader.js`
- Create: `src/adapters/firebase/realtimePresenceReader.js`
- Create: `database.rules.json`
- Modify: `firebase.json`
- Test: `tests/unit/presenceReader.test.js`
- Test: `tests/emulator/realtimePresenceRules.test.js`

**Interfaces:**
- `PresenceReader.getPresenceByFirebaseUid(firebaseUid) -> Promise<{ state: 'ONLINE'|'OFFLINE'|'UNKNOWN', lastOnlineAt: string|null }>`.
- Logical RTDB shape: `presence/{firebaseUid}/connections/{connectionId}` and `presence/{firebaseUid}/lastOnlineAt`.
- Client rule: authenticated UID may write only under its own presence path; broad presence reads are denied to normal clients.
- Trusted Admin reader may inspect presence for teacher read-model composition.

- [ ] **Step 1: Add RED presence tests**

Cover 0 connections→OFFLINE, 1+ connections→ONLINE, multiple devices remaining ONLINE until last connection disappears, backend read error→UNKNOWN, missing lastOnlineAt remains null, foreign student client write denied, own presence write allowed, roster-wide client read denied.

- [ ] **Step 2: Run focused/emulator tests and confirm RED**

Run: `node --test tests/unit/presenceReader.test.js`

Then:

```bash
firebase emulators:exec --project demo-st-student-account --only auth,database "node --test tests/emulator/realtimePresenceRules.test.js"
```

Expected: FAIL because presence adapter/rules do not exist.

- [ ] **Step 3: Implement trusted presence reader and RTDB rules**

Do not implement ST Student browser presence writer in this repo; that is a later cross-repository integration task. This task only locks the server read contract and security-rule behavior required for that future client.

- [ ] **Step 4: Run focused/emulator tests and verify GREEN**

Run both commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/presenceReader.js src/adapters/firebase/realtimePresenceReader.js database.rules.json firebase.json tests/unit/presenceReader.test.js tests/emulator/realtimePresenceRules.test.js
git commit -m "feat: add realtime student presence read model"
```

---

### Task 8: Teacher Student Management combined read model

**Files:**
- Create: `src/application/listTeacherStudents.js`
- Modify: `src/http/router.js`
- Test: `tests/unit/listTeacherStudents.test.js`
- Test: `tests/unit/httpTeacherStudentsApi.test.js`

**Interfaces:**
- `listTeacherStudentsService({ invitationRepository, studentAccountRepository, relationshipRepository, usageRepository, presenceReader }).execute({ teacherId })`.
- HTTP route: `GET /api/student-accounts/v1/teacher/students`.
- Response row shape:
  - `managementId`
  - `studentId: string|null`
  - `displayNameOrNickname`
  - `state: INVITED|ACTIVATING|ACTIVE|INACTIVE`
  - `invitationStatus: PENDING|ACCEPTED|REVOKED|EXPIRED|null`
  - `presenceState: ONLINE|OFFLINE|UNKNOWN`
  - `lastOnlineAt: string|null`
  - `lastSessionAt: string|null`
  - `totalSessions: integer >= 0`
- Assignment-facing roster projection is separately derivable as exactly `{ studentId, displayNameOrNickname, active }`; pending/activating rows are never active.

- [ ] **Step 1: Add RED combined-read tests**

Cover pending invite row before account exists, ACTIVATING not roster-active, ACTIVE row joining usage and presence, INACTIVE row preserving history, presence failure→UNKNOWN without failing the whole list, zero usage defaults, foreign teacher isolation, and no UID/email/token/private path leakage.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/listTeacherStudents.test.js tests/unit/httpTeacherStudentsApi.test.js`

Expected: FAIL because read-model service does not exist.

- [ ] **Step 3: Implement bounded join/read composition**

Prefer bounded parallel reads for independent usage/presence lookups; do not allow one presence failure to downgrade account/relationship authority. Keep ordering deterministic for tests and UI stability.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/listTeacherStudents.js src/http/router.js tests/unit/listTeacherStudents.test.js tests/unit/httpTeacherStudentsApi.test.js
git commit -m "feat: expose teacher student management read model"
```

---

### Task 9: Service composition, health endpoint, emulator composition, and privacy-safe observability

**Files:**
- Create: `src/composition.js`
- Create: `src/server.js`
- Modify: `src/adapters/firebase/firebaseAdmin.js`
- Modify: `src/http/errorResponse.js`
- Modify: `package.json`
- Test: `tests/contract/serviceComposition.test.js`
- Test: `tests/contract/securityRegression.test.js`

**Interfaces:**
- `createStudentAccountService({ config, adapters? }) -> { app, close? }`.
- `GET /health` returns only bounded service health, no provider/credential details.
- Production composition must require injected/configured `SecureDeliveryAuthorityPort`; default startup for implementation/emulator remains closed unless an explicit non-production fake/reference adapter is selected.
- Structured observability may include operation class, outcome, HTTP status, stable internal request correlation ID, and latency; it must exclude raw tokens, email unless explicitly redacted/hashed by policy, Firebase UID, password, invite token, service-account details, and Firestore paths.

- [ ] **Step 1: Add RED composition/security tests**

Cover health response, missing required Firebase config fails safely, missing production Secure Delivery adapter keeps activation closed, emulator composition uses emulator hosts without credentials, request/error serialization contains no known sample token/UID/email secret values, and shutdown does not leak listeners.

- [ ] **Step 2: Run contract tests and confirm RED**

Run: `node --test tests/contract/serviceComposition.test.js tests/contract/securityRegression.test.js`

Expected: FAIL because composition/server do not exist.

- [ ] **Step 3: Implement composition and startup scripts**

Add scripts at minimum: `test`, `test:unit`, `test:contract`, `test:emulator`, `start`, `dev`. Keep feature/authority writes closed unless the required adapter is deliberately supplied.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run the same command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composition.js src/server.js src/adapters/firebase/firebaseAdmin.js src/http/errorResponse.js package.json tests/contract
git commit -m "feat: compose student account service safely"
```

---

### Task 10: Full verification, API contract documentation, and integration handoff only

**Files:**
- Modify: `README.md`
- Create: `docs/api-v1.md`
- Create: `docs/integration-handoff.md`
- Create: `.github/workflows/ci.yml`
- Test: existing full suite only

**Interfaces:**
- `docs/api-v1.md` documents the exact V1 routes and bounded public response/error shapes without secrets.
- `docs/integration-handoff.md` lists the later Human-Gate work for ST Student, SesliTab, and production `SecureDeliveryAuthorityPort`; it is not permission to perform those changes.
- CI runs unit/contract tests on every change; emulator tests run with Firebase emulators and no production credentials.

- [ ] **Step 1: Add documentation/CI acceptance checks**

Document exact route list, environment variable names without secret values, local emulator command, privacy invariants, and explicit non-goals. CI must not contain service-account JSON or production project IDs.

- [ ] **Step 2: Run the complete local verification matrix**

Run:

```bash
npm test
npm run test:emulator
```

Expected: all tests PASS with zero production network dependency.

- [ ] **Step 3: Run repository hygiene checks**

Run:

```bash
git diff --check
node --check src/server.js
```

Inspect the full branch diff for credentials, raw UIDs/tokens, unrelated files, accidental cross-repository instructions, and dependency drift.

- [ ] **Step 4: Create/update a draft PR for account-service implementation**

The PR must remain draft and must explicitly state:

- no ST Student write;
- no SesliTab write;
- no production Secure Delivery adapter;
- no production Firebase rules/data/index/TTL deployment;
- no deploy/merge authorization.

- [ ] **Step 5: Stop at Human Gate**

Present fresh test/CI evidence and request approval before any of the following:

1. ST Student invite-route/account-creation integration;
2. ST Student RTDB presence writer + usage-session hook;
3. SesliTab Student Management UI/client integration;
4. production `SecureDeliveryAuthorityPort` adapter binding to current Secure Delivery provisioning/identity/grant contract;
5. production Firebase rules/index/TTL changes;
6. deploy or merge.

---

## Autonomous Execution Boundary

After this implementation plan is approved, an agent may autonomously complete Tasks 1–10 **inside `st-student-account-service` only**, including local/emulator tests, commits, CI configuration, and a draft PR. The agent must stop before any production or cross-repository integration action listed in Task 10 Step 5.

The production relationship remains:

```text
st-student-account-service
  -> SecureDeliveryAuthorityPort
  -> later human-approved adapter
  -> existing SesliTab Secure Delivery identityMappings + teacherStudentGrants
```

No account-service code may directly redefine those Secure Delivery collections as its own domain model.

## Plan Self-Review Result

- **Spec coverage:** invitation lifecycle, activation, stable IDs, Secure Delivery boundary, usage, presence, teacher read model, privacy, Firebase persistence/rules, API boundary, and human gates are each mapped to a task.
- **Type consistency:** port names and signatures are defined once and reused by downstream tasks.
- **Review Focus:** all five high-risk cases have explicit owning tests.
- **Scope:** this plan intentionally stops before ST Student/SesliTab source changes and before production authority/deployment.
- **YAGNI:** no Gmail/SMTP integration, custom JWT, WebSocket service, analytics SDK, device tracking, group/classroom model, push notifications, or new hosting service is introduced.
