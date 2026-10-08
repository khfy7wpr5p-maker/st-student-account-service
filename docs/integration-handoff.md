# ST Student Account Service — Integration Handoff

Status: backend V1 implementation handoff. This document defines later Human-Gate integration work only. It does **not** authorize cross-repository changes, production Firebase changes, deploy, or merge.

## Backend V1 now available

The account service provides:

- seven-day invitation creation, resolution, acceptance, and revoke lifecycle;
- stable student identity and teacher-student relationship orchestration;
- Firestore persistence with private browser rules;
- idempotent authenticated usage-session counting with 30-day session retention metadata;
- trusted Realtime Database presence reading with `ONLINE | OFFLINE | UNKNOWN` semantics;
- teacher-scoped combined Student Management read model;
- bounded HTTP errors, privacy-safe request observability, `/health`, and controlled shutdown;
- production fail-closed behavior when `SecureDeliveryAuthorityPort` is not configured.

The backend does not replace Firebase Authentication or the existing Secure Delivery assignment authority.

## Human Gate 1 — ST Student invite flow

Later ST Student work must:

1. Recognize the fragment route `#/invite/<raw-token>` from the existing Student App host.
2. Keep the raw token out of query strings, ordinary request paths, analytics, logs, screenshots, and persistent app storage.
3. Send `{ inviteToken }` to `POST /api/student-accounts/v1/public/invitations/resolve`.
4. For `accountMode=CREATE`, keep the invited email fixed and create the Firebase account directly with the Firebase Web SDK; the account-service backend must never receive the password.
5. For `accountMode=SIGN_IN`, use the existing Firebase sign-in flow rather than creating a second account.
6. After Firebase authentication, call `POST /api/student-accounts/v1/student/invitations/accept` with the Firebase bearer token and raw invite token in the JSON body.
7. Treat `relationshipState=ACTIVE` as the completed activation result; do not infer authority from email, display name, invitation ID, or presence.

## Human Gate 2 — ST Student presence writer and usage-session hook

Later ST Student presence integration must use Realtime Database under the authenticated user's own UID path only:

```text
presence/{firebaseUid}/connections/{connectionId} = true
presence/{firebaseUid}/lastOnlineAt = server timestamp
```

Required client lifecycle:

1. Observe `.info/connected`.
2. Create a unique connection child only while connected.
3. Register `onDisconnect().remove()` before treating the connection as online.
4. Register/update `lastOnlineAt` on disconnect.
5. Release stale listeners/connection ownership on sign-out and teardown.
6. Preserve offline practice behavior if presence is unavailable.

Usage integration must generate one new bounded `clientSessionId` per authenticated application boot/page lifecycle and send it once to `POST /api/student-accounts/v1/student/sessions`. Retries for that same boot must reuse the same ID so the server remains idempotent. Playback, reconnects, notation changes, assignment opens, and elapsed time must not create extra usage sessions.

## Human Gate 3 — SesliTab Student Management UI/client

Later SesliTab work must consume the account-service APIs rather than reading account-service Firestore/RTDB collections directly.

Student Management should support:

- create invitation from email + display name/nickname;
- copy the one-time invitation link for manual sending from the teacher's existing email account;
- list management rows from `GET /api/student-accounts/v1/teacher/students`;
- display `INVITED | ACTIVATING | ACTIVE | INACTIVE`;
- display `ONLINE | OFFLINE | UNKNOWN` without using presence as authority;
- display `lastOnlineAt`, `lastSessionAt`, and `totalSessions` as informational metadata;
- revoke an owned pending invitation.

The teacher client must never supply authoritative `teacherId` or `studentId` values. Teacher identity must continue to be resolved server-side from the verified Firebase identity.

## Human Gate 4 — production Secure Delivery authority adapter

A production implementation of `SecureDeliveryAuthorityPort` must bind to the **existing** Secure Delivery identity/provisioning/grant contract.

Required operation:

```text
activateStudent({
  firebaseUid,
  teacherId,
  studentId,
  activatedAt,
  sourceInviteId
})
```

Required acknowledgement:

```text
studentId = exact requested stable studentId
teacherId = exact requested stable teacherId
identityActive = true
grantActive = true
```

Requirements:

- same exact request is idempotent;
- no competing assignment-authority schema is introduced;
- email, display name, invitation ID, presence, or client-supplied stable IDs cannot grant assignment authority;
- partial failure is retry-safe;
- relationship/account state is not exposed as `ACTIVE` before exact authority acknowledgement and local finalization converge.

Before production activation, contract-test the adapter against the current Secure Delivery V1 provisioning/identity/grant semantics.

## Human Gate 5 — production Firebase changes

Production application requires a separate reviewed change for:

- deployment of `firestore.rules`;
- deployment of `database.rules.json`;
- Firestore index configuration as required by the production project;
- 30-day TTL policy for usage-session idempotency records;
- production project/database configuration;
- credentials/service identity supplied by the deployment platform, not committed files.

Do not use the demo emulator project ID as a production project ID.

## Human Gate 6 — deploy and merge

Only after the preceding integration gates are reviewed:

1. run the complete account-service unit, contract, and emulator matrix;
2. run ST Student invitation/presence/session integration tests;
3. run SesliTab Student Management API/UI integration tests;
4. run Secure Delivery authority contract tests;
5. verify privacy/logging boundaries with production-like configuration;
6. obtain explicit approval for production Firebase changes;
7. obtain explicit approval for deployment and merge.

## Explicit non-goals for this handoff

This handoff does not authorize or introduce:

- a second login/password system;
- custom JWT issuance;
- Gmail/SMTP integration;
- analytics SDKs, device fingerprinting, IP profiling, or location tracking;
- custom WebSocket presence infrastructure;
- classroom/group semantics;
- push notifications;
- direct account-service ownership of existing Secure Delivery identity/grant collections;
- writes to `st-student-app` or `seslitab-guitar-reader` before the Human Gate.

## Current stop point

The account-service repository may be verified and reviewed in a draft PR. Cross-repository integration, production Firebase changes, deploy, and merge remain blocked until explicit Human-Gate approval.
