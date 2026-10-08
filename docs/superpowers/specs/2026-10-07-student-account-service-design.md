# ST Student Account Service — Student Management Architecture Design

Date: 2026-10-07  
Repository: `khfy7wpr5p-maker/st-student-account-service`  
Path: Architectural  
Status: Design specification awaiting human review  

## 1. Purpose

`st-student-account-service` is the shared student-management authority between the SesliTab teacher application and ST Student.

The first product scope is intentionally narrow:

1. teacher-created student invitation links;
2. teacher/student relationship activation;
3. online/offline presence read model;
4. privacy-minimized usage counters;
5. projection of active students into the existing SesliTab roster / Secure Delivery authority model.

The service does **not** replace Firebase Authentication, ST Student login, Secure Delivery assignment authority, Ödev Gönder, Ödev Yönetimi, SCORE/TAB/Chord payload delivery, or Student App offline content storage.

The product rule is:

> Student-management complexity stays behind one service boundary; teacher and student applications receive only the minimum read/write capabilities they need.

## 2. Approved Product Decisions

The following decisions are fixed for V1:

- The existing ST Student email/password login screen remains the normal login surface.
- A new student is added through a teacher-generated invitation link.
- SesliTab does not send email itself in V1.
- The teacher copies the invitation link and sends it using the teacher's existing Gmail account.
- No custom application domain is required for V1.
- Student management is a separate SesliTab product area, not embedded inside Ödev Yönetimi.
- The Student Management view contains invitation state, active student state, presence, last use, and total session count.
- Presence and usage are informational only; neither may grant assignment authority.
- The student's password is never received, stored, logged, or processed by `st-student-account-service`.
- No device fingerprinting, location tracking, IP analytics, behavioral event stream, or third-party analytics SDK is introduced.

## 3. Existing Contracts That Must Be Preserved

### 3.1 ST Student authentication

ST Student already authenticates with Firebase email/password and restores local Firebase sessions.

This service must reuse the same authenticated Firebase identity. It must not introduce a second login system, second password database, custom JWT issuer, or credential store.

### 3.2 Stable SesliTab identities

Existing Secure Delivery deliberately separates Firebase identity from stable SesliTab domain identity:

`Firebase UID != studentId / teacherId`

This invariant remains mandatory.

### 3.3 Existing student roster contract

The current SesliTab roster contract is conceptually:

```text
StudentRosterEntry
studentId
displayNameOrNickname
active
```

`displayNameOrNickname` is presentation data. `studentId` is the stable domain identity. `active` controls whether the teacher may target the student through roster preflight.

The account service must produce data compatible with this contract rather than inventing a second incompatible roster model.

### 3.4 Existing Secure Delivery identity and teacher-student authority

Secure Delivery already uses server-side authority records equivalent to:

```text
FirebaseIdentityMapping
providerSubject (Firebase UID)
role: TEACHER | STUDENT
teacherId | studentId
active
```

and:

```text
TeacherStudentGrant
teacherId
studentId
active
createdAt
revokedAt
```

The new service must never treat a relationship as active for assignment purposes unless the corresponding Secure Delivery stable identity and teacher-student grant are also active.

## 4. Architecture

```text
                     SesliTab teacher UI
                    Student Management
                           |
                           | Firebase teacher ID token
                           v
              +-------------------------------+
              | st-student-account-service    |
              |                               |
              | invitation domain             |
              | account / relationship domain |
              | usage domain                  |
              | presence read model           |
              | roster projection             |
              +---------+-----------+---------+
                        |           |
             Firestore  |           | Realtime Database
                        |           |
                        v           v
             invitations/accounts   presence connections
             relationships/usage    last-online signal
                        ^
                        |
                        | Firebase student ID token
                        |
                    ST Student
              existing Firebase login
              invite activation route
              presence + session-start
```

The account service owns student-management orchestration. Firebase remains an adapter, not the public domain contract.

## 5. Technology Decision

V1 aligns with the existing SesliTab/Firebase stack:

- Node.js 24;
- ECMAScript modules;
- Express 4.x;
- Firebase Admin SDK 14.x;
- Firebase JavaScript SDK 12.x in browser integrations;
- Cloud Firestore for durable invitation, account, relationship and usage data;
- Firebase Realtime Database for connection-based presence;
- `node:crypto` for cryptographically secure invitation tokens and SHA-256 token fingerprints;
- `node:test` for unit/contract tests;
- Firebase Emulator Suite for Auth/Firestore/Realtime Database integration tests;
- `@firebase/rules-unit-testing` where security-rule verification is required.

V1 must not add a custom JWT package, password hashing package, UUID package, WebSocket server, analytics SDK, or second authentication provider unless a demonstrated requirement cannot be met by the existing stack.

## 6. Domain Model

### 6.1 StudentInvitation

Logical record:

```text
StudentInvitation
schemaVersion: 1
inviteId
teacherId
emailNormalized
studentDisplayNameOrNickname
status: PENDING | ACCEPTED | REVOKED | EXPIRED
tokenHash
createdAt
expiresAt
acceptedAt: nullable
revokedAt: nullable
studentId: nullable
```

Rules:

- invitation lifetime is seven days;
- raw invitation tokens are never stored;
- `tokenHash` is `SHA-256(rawToken)`;
- an accepted/revoked/expired invitation cannot be accepted later;
- invitation acceptance is one-way;
- V1 allows only one live `PENDING` invitation per `teacherId + emailNormalized` pair;
- creating a second live invitation for the same pair fails with a bounded conflict; a later resend feature must rotate/revoke explicitly rather than silently creating multiple valid tokens;
- email is used only to bind the invitation to the intended Firebase account; it is never a domain authorization key for assignments.

### 6.2 StudentAccount

Logical server-private record:

```text
StudentAccount
schemaVersion: 1
studentId
firebaseUid
emailNormalized
createdAt
active
```

Rules:

- `studentId` is generated as the stable SesliTab domain identity;
- `firebaseUid` remains server-private and must never appear in the normal teacher/student read model;
- one active Firebase UID maps to one student account;
- one student account maps to one stable `studentId`;
- email changes must not silently change `studentId`.

### 6.3 TeacherStudentRelationship

Logical record:

```text
TeacherStudentRelationship
schemaVersion: 1
relationshipId
teacherId
studentId
displayNameOrNickname
active
createdAt
activatedAt
deactivatedAt: nullable
sourceInviteId
```

Rules:

- the teacher may list only their own relationships;
- the relationship uses stable IDs, never email, name, or Firebase UID as authority;
- V1 activation is created only from a valid invitation;
- `active=false` removes the student from new teacher roster targeting but does not hard-delete historical assignment/audit data;
- V1 does not add multi-teacher classroom/group semantics beyond independent teacher-student relationships.

### 6.4 StudentUsageSummary

```text
StudentUsageSummary
schemaVersion: 1
studentId
totalSessions
lastSessionAt
```

### 6.5 StudentUsageSession

```text
StudentUsageSession
schemaVersion: 1
studentId
clientSessionId
startedAt
expiresAt
```

The event record exists for idempotency and bounded audit, not behavioral analytics.

A usage session means: **one authenticated ST Student application boot/page lifecycle**.

It does not mean clicks, playback starts, notation switches, reconnects, assignment opens, or time spent in the application.

A newly generated `clientSessionId` is sent once after an authenticated app boot. Duplicate submissions of the same ID must not increment the counter twice.

Usage-session idempotency records are retained for 30 days. Production TTL configuration is a separate deployment gate. The aggregate `StudentUsageSummary` remains after event expiry.

## 7. Invitation Link Design

### 7.1 Token generation

The backend generates at least 256 bits of cryptographically secure random data using Node's built-in cryptography APIs.

Only the SHA-256 fingerprint is stored server-side.

### 7.2 Link shape

The future ST Student integration uses the existing stable Student App host and carries the raw invitation token in the URL fragment, for example:

```text
https://st-student-app.onrender.com/#/invite/<raw-token>
```

The URL fragment is chosen because browsers do not send it in the normal HTTP request line, reducing accidental token exposure in standard hosting request logs and referrer processing.

The raw token remains a bearer secret until accepted, revoked, or expired. It must never be written to normal application logs, analytics, Notion, Linear, GitHub, screenshots used as engineering evidence, or server error messages.

### 7.3 Teacher workflow

```text
SesliTab
  -> Student Management
  -> Create Invitation
  -> enter email + display name/nickname
  -> service returns one invitation link once
  -> teacher copies link
  -> teacher sends link from personal Gmail
```

The service does not connect to Gmail/SMTP in V1.

## 8. Student Invitation Acceptance

The normal login screen remains unchanged for ordinary users. An invitation link opens a bounded invitation-activation route/view in ST Student during the later integration stage.

### 8.1 Resolve invitation

ST Student extracts the token from the URL fragment and sends it in a request body to:

```text
POST /api/student-accounts/v1/public/invitations/resolve
```

The token is never placed back into query parameters or loggable path segments.

A valid response contains only the minimum activation display model:

```text
inviteId
studentDisplayNameOrNickname
email
expiresAt
accountMode: CREATE | SIGN_IN
```

### 8.2 New Firebase account

If Firebase has no existing account for the invitation email:

1. invitation view fixes the email to the invited address;
2. the student chooses a password in the browser;
3. ST Student calls Firebase Web SDK `createUserWithEmailAndPassword` directly;
4. the password goes only to Firebase Auth;
5. ST Student obtains the resulting Firebase ID token;
6. ST Student calls the account service acceptance endpoint with the invite token in the JSON body and Firebase bearer token in `Authorization`.

The account-service backend never receives the password.

### 8.3 Existing Firebase account

If the invitation email already belongs to an existing Firebase account:

1. invitation view directs the student to sign in with the existing credentials;
2. no forced password reset is performed;
3. after authentication, the same invitation acceptance endpoint is called.

This preserves existing test/student accounts and avoids unnecessary credential rotation.

### 8.4 Acceptance authorization

```text
POST /api/student-accounts/v1/student/invitations/accept
Authorization: Bearer <Firebase ID token>
Body: { inviteToken }
```

The backend must verify all of the following before activation:

- Firebase ID token is valid;
- token contains a usable UID and email;
- invitation token fingerprint matches exactly one `PENDING` invitation;
- invitation is not expired or revoked;
- normalized authenticated Firebase email equals invitation email;
- UID is not mapped to a conflicting stable student identity;
- invitation has not already been consumed by another UID.

Any ambiguity fails closed.

## 9. Activation Transaction and Secure Delivery Compatibility

Invitation acceptance is not complete until student-management state and assignment authority agree.

The activation operation must produce the following logical result atomically from the user's point of view:

1. stable `studentId` exists;
2. Firebase UID maps to that stable `studentId` as active STUDENT identity;
3. `TeacherStudentGrant(teacherId, studentId)` is active;
4. `TeacherStudentRelationship` is active;
5. invitation becomes `ACCEPTED` and references the same `studentId`;
6. the teacher roster projection returns that `studentId`, `displayNameOrNickname`, `active=true`.

The service core therefore defines a narrow port:

```text
SecureDeliveryAuthorityPort.activateStudent({
  firebaseUid,
  teacherId,
  studentId,
  activatedAt,
  sourceInviteId
})
```

and requires exact acknowledgement of:

```text
studentId
teacherId
identityActive=true
grantActive=true
```

### 9.1 Integration rule

V1 core development must **not** create an independent competing assignment-authority schema.

During the later SesliTab integration stage, the production adapter for `SecureDeliveryAuthorityPort` must bind to the existing Secure Delivery provisioning/identity/grant contract. That adapter must be contract-tested against the current Secure Delivery V1 semantics before production activation.

The integration adapter may not authorize students by display name, email, invitation ID, or client-supplied stable IDs.

### 9.2 Failure behavior

If Secure Delivery authority activation fails, the invitation must remain retryable and the teacher/student relationship must not be presented as fully active.

The service uses an explicit intermediate internal state only if required by the persistence adapter, but the public teacher model exposes only bounded states such as:

```text
INVITED
ACTIVATING
ACTIVE
INACTIVE
```

`ACTIVATING` must never be accepted by Ödev Gönder roster preflight.

## 10. Teacher Roster Projection

The account service exposes a teacher-scoped student read model compatible with the existing roster contract.

The assignment-facing projection is exactly:

```text
studentId
displayNameOrNickname
active
```

Additional Student Management presentation fields are separate and cannot become assignment authority:

```text
invitationStatus
presenceState
lastOnlineAt
lastSessionAt
totalSessions
```

SesliTab's assignment composer must continue to use stable `studentId` and active roster authority.

## 11. Presence Architecture

Cloud Firestore alone is not used as the authoritative online/offline mechanism.

Firebase Realtime Database is used because it provides connection state and `onDisconnect()` behavior.

Logical RTDB layout:

```text
presence/{firebaseUid}/connections/{connectionId} = true
presence/{firebaseUid}/lastOnlineAt = server timestamp
```

ST Student behavior after authentication:

1. observe `.info/connected`;
2. create a unique connection node only when connected;
3. register `onDisconnect().remove()` before considering the connection online;
4. register/update `lastOnlineAt` on disconnect;
5. remove/replace stale local listener ownership during sign-out or app teardown.

Presence rules:

- authenticated students may write only below their own UID path;
- students do not receive teacher/student roster-wide presence read authority;
- teacher UI does not read RTDB directly;
- account service reads presence using trusted server credentials and returns only presence for students in the authenticated teacher's active/pending management scope;
- presence failure must not break login, offline practice, assignment reads, or Secure Delivery authorization;
- presence state is never an authorization signal.

Multi-device semantics:

- one or more active connection children -> `ONLINE`;
- zero active connection children -> `OFFLINE`;
- `lastOnlineAt` is presentation metadata only.

## 12. Usage Counter Architecture

ST Student sends one bounded session-start command per authenticated application boot:

```text
POST /api/student-accounts/v1/student/sessions
Authorization: Bearer <Firebase ID token>
Body: { clientSessionId }
```

The backend:

1. verifies Firebase identity;
2. resolves active stable `studentId`;
3. validates bounded session ID syntax/length;
4. performs an idempotent Firestore transaction;
5. if the session event is new, increments `totalSessions` once and sets `lastSessionAt` to a server timestamp;
6. if the same session event already exists, returns the existing acknowledgement without incrementing again.

No periodic heartbeat is used for the usage counter. Presence is responsible for connection state.

## 13. Teacher Student-Management Read Model

SesliTab receives one bounded read model rather than performing separate client calls to invitation, usage, Firestore and RTDB stores.

```text
GET /api/student-accounts/v1/teacher/students
Authorization: Bearer <Firebase teacher ID token>
```

Example logical response row:

```text
managementId
studentId: nullable while invitation is pending
displayNameOrNickname
state: INVITED | ACTIVATING | ACTIVE | INACTIVE
invitationStatus: PENDING | ACCEPTED | REVOKED | EXPIRED | null
presenceState: ONLINE | OFFLINE | UNKNOWN
lastOnlineAt: nullable
lastSessionAt: nullable
totalSessions: non-negative integer
```

Rules:

- `UNKNOWN` is used when presence cannot be resolved; it must not be mislabeled `OFFLINE`;
- Firebase UID is never returned;
- Firebase ID token is never returned;
- raw invitation token is never returned after the one-time create response;
- password/credential fields do not exist;
- internal Firestore paths/IDs are not required by the UI;
- teacher can read only their own invitations/relationships.

## 14. HTTP API V1

### Teacher

```text
POST /api/student-accounts/v1/teacher/invitations
GET  /api/student-accounts/v1/teacher/students
POST /api/student-accounts/v1/teacher/invitations/:inviteId/revoke
```

`POST /teacher/invitations` returns the raw invitation link exactly once in the successful create response.

### Public invitation resolution

```text
POST /api/student-accounts/v1/public/invitations/resolve
```

The raw token is submitted in the JSON body.

### Authenticated student

```text
POST /api/student-accounts/v1/student/invitations/accept
POST /api/student-accounts/v1/student/sessions
```

### Service health

```text
GET /health
```

No V1 endpoint accepts client-supplied `teacherId` or `studentId` as authorization proof.

## 15. Authentication and Authorization

### Teacher endpoints

Teacher request flow:

```text
Firebase ID token
 -> Firebase Admin verifyIdToken()
 -> existing stable teacher identity resolution
 -> teacherId
 -> teacher-scoped account-service operation
```

A Firebase login without a valid active TEACHER identity mapping has no teacher authority.

### Student endpoints

Student request flow:

```text
Firebase ID token
 -> Firebase Admin verifyIdToken()
 -> active student identity mapping / invitation activation logic
 -> stable studentId
 -> student-scoped operation
```

Normal post-activation student calls must fail closed if identity mapping is missing/disabled.

## 16. Privacy and Logging

The service must not log or expose:

- passwords;
- Firebase ID tokens;
- service-account credentials;
- raw invitation tokens;
- Firebase UID in normal request/application logs;
- full Authorization headers;
- device fingerprints;
- precise location;
- IP-derived profiles;
- detailed student behavior trails.

Privacy-safe logs may include:

```text
request correlation ID
route class
bounded outcome code
stable internal operation ID
latency
non-sensitive state transition
```

Teacher-facing destructive/relationship UI must not require displaying Firebase UID, raw token, or internal transport identifiers.

The repository is public. No Firebase service-account JSON, API secret intended to be secret, private key, production token, raw student identifier export, or production database dump may be committed.

## 17. Error Handling

Public errors are bounded and stable.

Examples:

```text
AUTH_REQUIRED
TEACHER_AUTHORITY_REQUIRED
INVITE_NOT_FOUND
INVITE_EXPIRED
INVITE_REVOKED
INVITE_ALREADY_ACCEPTED
INVITE_EMAIL_MISMATCH
INVITE_ALREADY_PENDING
IDENTITY_CONFLICT
AUTHORITY_ACTIVATION_FAILED
STUDENT_ACCOUNT_INACTIVE
PRESENCE_UNAVAILABLE
```

No error response includes a token, Firebase UID, Firestore path, stack trace, service-account detail, or unrelated student's existence.

The public invitation resolver should use bounded responses that avoid becoming an email/account enumeration endpoint.

## 18. Persistence Boundaries

Logical Firestore collections owned by the new service:

```text
studentInvitations/{inviteId}
studentAccounts/{studentId}
teacherStudentRelationships/{relationshipId}
studentUsage/{studentId}
studentUsage/{studentId}/sessions/{clientSessionId}
```

Exact physical collection names may be prefixed/namespaced by the Firebase adapter, but domain services must not depend on Firestore paths.

Existing Secure Delivery authority collections remain owned by Secure Delivery. They are reached through `SecureDeliveryAuthorityPort`, not redefined as account-service domain collections.

Direct browser Firestore access to the service-owned private collections is denied in V1. Browser operations go through the authenticated HTTP API, except RTDB self-presence writes under Security Rules.

## 19. Repository Structure

Target structure:

```text
src/
  domain/
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

contracts/
  student-account-api-v1.md

firebase/
  database.rules.json
  firestore.rules
  firestore.indexes.json
  firebase.json

tests/
  unit/
  contract/
  emulator/

docs/
  superpowers/
    specs/
    plans/
```

The `SecureDeliveryAuthorityPort` production adapter is intentionally an integration-stage component because it must be verified against the then-current Secure Delivery contract before cross-repository authority writes are enabled.

## 20. Test Strategy

### Unit/domain tests

Must cover:

- strict invitation schema;
- seven-day expiry boundary;
- raw token never persisted;
- exact token fingerprint match;
- single pending teacher/email rule;
- one-way accept/revoke/expire transitions;
- stable student ID generation/validation;
- relationship activation/deactivation;
- usage idempotency;
- no usage increment on duplicate session event;
- teacher read-model sanitization;
- bounded error mapping.

### Auth/authorization contract tests

Must cover:

- missing/invalid Firebase token -> deny;
- STUDENT token on teacher endpoint -> deny;
- TEACHER token on student endpoint -> deny where role is resolved;
- foreign teacher cannot list/revoke another teacher's invitation;
- invitation email mismatch -> deny without consuming invite;
- conflicting UID/student mapping -> fail closed;
- inactive identity -> deny post-activation student operations;
- no client-supplied teacher/student ID grants authority.

### Firebase emulator tests

Must cover:

- Firestore invitation persistence;
- accept idempotency/race behavior;
- concurrent double-accept -> only one winner, no split identity;
- usage session transaction atomicity;
- duplicate session event -> one total increment;
- RTDB student can write own presence path only;
- RTDB student cannot write another UID's path;
- browser cannot directly read service-owned private Firestore collections;
- admin/server adapters can read required data;
- offline/disconnect presence cleanup behavior where emulator support allows deterministic proof.

### Cross-repository integration tests — later Human Gate

Before SesliTab production integration is accepted, prove:

```text
invite accepted
 -> stable studentId provisioned
 -> Secure Delivery STUDENT identity active
 -> teacher/student grant active
 -> account-service relationship ACTIVE
 -> roster projection active
 -> existing Ödev Gönder preflight accepts student
```

Failure at the authority boundary must prove the student does not become assignment-targetable.

### ST Student integration tests — later Human Gate

Must prove:

- existing login behavior remains unchanged when no invite fragment exists;
- invite route can create a Firebase account without password reaching account-service backend;
- existing Firebase account uses sign-in path rather than forced reset;
- invite token is removed from visible location/history as soon as safely possible after capture;
- sign-out tears down presence ownership;
- authenticated boot sends one idempotent usage session command;
- presence failure does not block app use;
- existing offline practice remains unchanged.

## 21. Performance Constraints

V1 is a teacher-scale management service, not a high-frequency analytics platform.

Rules:

- no periodic Firestore usage heartbeat;
- no periodic teacher polling by default;
- no network request for each Student Management subview switch;
- `GET /teacher/students` returns one bounded snapshot;
- presence reads for roster students may execute concurrently with a bounded concurrency limit;
- a presence timeout produces `UNKNOWN`, not failure of the whole roster response;
- invitation and relationship authority reads must fail closed rather than rely on stale presence/usage data.

## 22. Accessibility and UI Boundary

The service does not own the full SesliTab/Student UI, but its contracts must support accessible UI.

Teacher Student Management states must have text equivalents; color alone cannot represent online/invite state.

The later SesliTab UI must support:

- keyboard/focus operation;
- VoiceOver-readable invitation and student state;
- live status for create/revoke outcomes;
- explicit confirmation before relationship/invitation destructive actions where applicable.

The existing ST Student login accessibility behavior must not regress.

## 23. Non-Goals

V1 does not include:

- Gmail API/SMTP integration;
- SMS invitations;
- push notifications;
- parent/guardian accounts;
- classes/groups/cohorts;
- chat or direct messaging;
- attendance tracking;
- time-on-task analytics;
- detailed click/playback analytics;
- grading/gamification;
- device fingerprinting;
- geolocation;
- custom domain;
- password recovery redesign;
- replacing existing Firebase login;
- replacing Secure Delivery;
- assignment lifecycle management;
- SCORE/TAB/Chord transport;
- automatic production migration of existing accounts;
- production deploy or Firebase rule deployment as part of architecture approval.

## 24. Existing Account Compatibility

Existing Firebase student accounts must continue to sign in normally.

An existing account can become teacher-linked through an invitation if:

- authenticated email matches the invitation email;
- its UID has no conflicting stable student identity; or
- its existing stable student identity is compatible with the intended relationship.

The implementation must reuse a compatible existing stable `studentId` rather than create a duplicate identity.

Existing test/student accounts are never automatically migrated merely because this service is deployed.

## 25. Autonomous Development Boundary

After this written specification and the subsequent implementation plan are explicitly approved, the account-service repository may be developed autonomously through the following **standalone** boundary:

Autonomous:

- provider-neutral domain contracts;
- HTTP contracts;
- in-memory repositories/fakes;
- Firebase Admin composition that defaults closed;
- Firestore adapters against emulators;
- Realtime Database presence adapter/rules against emulators;
- unit/contract/emulator tests;
- CI configuration;
- security/privacy regression tests;
- documentation;
- draft pull request creation and updates.

Requires a new Human Gate:

- any write to `st-student-app`;
- any write to `seslitab-guitar-reader`;
- production implementation/activation of `SecureDeliveryAuthorityPort`;
- production Firebase data/rules/index/TTL changes;
- migration of an existing Firebase/student identity;
- addition/change of secrets or service-account credentials;
- creation of a Render/Vercel/Firebase hosting service or URL;
- deployment;
- merge;
- production invitation creation.

The default runtime/configuration must fail closed when production authority adapters or required configuration are absent.

## 26. Implementation Sequencing Constraints

The later implementation plan must preserve this dependency order:

```text
Domain contracts
  -> invitation lifecycle
  -> HTTP/auth boundary
  -> Firestore adapters + emulator security
  -> usage idempotency
  -> RTDB presence
  -> combined teacher read model
  -> standalone CI/security qualification
  -> HUMAN GATE
  -> Secure Delivery authority integration
  -> HUMAN GATE
  -> ST Student invite/presence/usage integration
  -> HUMAN GATE
  -> SesliTab Student Management UI integration
  -> physical/mobile E2E qualification
  -> HUMAN GATE for production/deploy/merge
```

No implementation worker may skip ahead by creating a temporary production authority path.

## 27. Acceptance Criteria

The architecture is satisfied only when all of the following are demonstrated with fresh evidence:

1. teacher can create one seven-day single-use invitation link;
2. raw invite token is returned once and never persisted/logged;
3. teacher can revoke a pending invitation;
4. invited new student can create Firebase credentials without password reaching account service;
5. invited existing Firebase student can authenticate without forced password reset;
6. acceptance requires matching authenticated email;
7. one invite cannot activate two different Firebase identities;
8. successful activation produces one stable `studentId`;
9. successful activation produces active Secure Delivery identity + teacher/student grant before roster authority becomes active;
10. SesliTab roster projection remains compatible with `studentId + displayNameOrNickname + active`;
11. presence correctly handles multiple connections and disconnect cleanup;
12. presence failure is isolated from login/assignment/offline practice;
13. one authenticated app boot increments usage once;
14. duplicate session submission does not double count;
15. teacher receives one sanitized Student Management snapshot;
16. foreign teacher/student access fails closed;
17. passwords, raw Firebase tokens, raw invite tokens and Firebase UID do not leak through normal UI/API/log responses;
18. existing ST Student login and Secure Delivery behavior remains unchanged until separately approved integrations are performed;
19. all unit/contract/emulator/security checks pass on exact branch SHA;
20. production deployment, data migration, merge and cross-repository changes remain separate explicit Human Gates.

## 28. Decision Summary

The approved V1 architecture is:

- one separate repository: `st-student-account-service`;
- one student-management service with isolated `invitations`, `relationships`, `presence`, and `usage` modules;
- Firebase Auth remains the credential authority;
- Firestore stores invitations/accounts/relationships/usage;
- Realtime Database owns online/offline connection presence;
- SesliTab keeps assignment/Ödev authority;
- existing Secure Delivery stable identities and grants remain assignment authorization authority;
- account service activates/projections through a narrow Secure Delivery authority port rather than redefining that subsystem;
- teacher manually sends the generated invitation link using Gmail;
- existing ST Student login remains the normal login surface;
- cross-repository integration and all production changes remain explicit Human Gates.
