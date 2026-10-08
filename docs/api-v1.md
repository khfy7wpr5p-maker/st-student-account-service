# ST Student Account Service — API V1

This document describes the bounded public HTTP contract for `st-student-account-service` V1.

## Base behavior

- JSON request/response bodies only for API commands.
- Firebase ID tokens are accepted only through `Authorization: Bearer <token>` on authenticated routes.
- Raw invitation tokens are accepted only in JSON request bodies. They must not be placed in query parameters or API path segments.
- `teacherId`, `studentId`, Firebase UID, token hashes, provider object paths, and credentials are never accepted as client authority.
- Public error bodies are bounded and never echo internal exception text.

## Health

### `GET /health`

Response `200`:

```json
{ "status": "ok" }
```

The response intentionally contains no Firebase project, credential, database, host, adapter, or dependency details.

## Invitation resolution

### `POST /api/student-accounts/v1/public/invitations/resolve`

Body:

```json
{ "inviteToken": "<raw invitation token>" }
```

Response `200`:

```json
{
  "inviteId": "invite-...",
  "studentDisplayNameOrNickname": "Student",
  "email": "student@example.invalid",
  "expiresAt": "2026-10-15T00:00:00.000Z",
  "accountMode": "CREATE"
}
```

`accountMode` is `CREATE` or `SIGN_IN`.

## Teacher invitation creation

### `POST /api/student-accounts/v1/teacher/invitations`

Requires a valid Firebase teacher bearer token. The stable `teacherId` is resolved server-side.

Body:

```json
{
  "email": "student@example.invalid",
  "displayNameOrNickname": "Student"
}
```

Response `201`:

```json
{
  "inviteId": "invite-...",
  "displayNameOrNickname": "Student",
  "email": "student@example.invalid",
  "expiresAt": "2026-10-15T00:00:00.000Z",
  "state": "INVITED",
  "invitationLink": "https://student-app.example.invalid/#/invite/<raw-token>"
}
```

The invitation link is the one-time raw-token delivery surface. Only the SHA-256 token fingerprint is persisted by the service.

## Teacher student-management list

### `GET /api/student-accounts/v1/teacher/students`

Requires a valid Firebase teacher bearer token. The stable `teacherId` is resolved server-side.

Response `200`:

```json
{
  "students": [
    {
      "managementId": "invite-...",
      "studentId": "student-...",
      "displayNameOrNickname": "Student",
      "state": "ACTIVE",
      "invitationStatus": "ACCEPTED",
      "presenceState": "ONLINE",
      "lastOnlineAt": "2026-10-08T05:00:00.000Z",
      "lastSessionAt": "2026-10-08T04:55:00.000Z",
      "totalSessions": 3
    }
  ]
}
```

`state` is one of `INVITED | ACTIVATING | ACTIVE | INACTIVE`.

`presenceState` is one of `ONLINE | OFFLINE | UNKNOWN`. `UNKNOWN` is intentionally distinct from `OFFLINE` and presence never grants assignment authority.

`studentId` may be `null` while an invitation is still pending.

## Teacher invitation revoke

### `POST /api/student-accounts/v1/teacher/invitations/:inviteId/revoke`

Requires a valid Firebase teacher bearer token. Ownership is checked against the server-resolved teacher identity.

Response `200`:

```json
{
  "inviteId": "invite-...",
  "status": "REVOKED"
}
```

## Student invitation acceptance

### `POST /api/student-accounts/v1/student/invitations/accept`

Requires a valid Firebase student bearer token.

Body:

```json
{ "inviteToken": "<raw invitation token>" }
```

Response `200`:

```json
{
  "studentId": "student-...",
  "relationshipState": "ACTIVE"
}
```

In production, this route remains unavailable until an explicitly configured `SecureDeliveryAuthorityPort` confirms both stable identity and teacher-student grant activation. The service does not create a competing assignment-authority schema.

## Student usage session

### `POST /api/student-accounts/v1/student/sessions`

Requires a valid Firebase student bearer token.

Body:

```json
{ "clientSessionId": "boot-unique-id" }
```

Response `200`:

```json
{
  "isNew": true,
  "totalSessions": 4,
  "lastSessionAt": "2026-10-08T05:10:00.000Z"
}
```

A usage session means one authenticated application boot/page lifecycle. Duplicate submission of the same `clientSessionId` is idempotent and must not increment the counter twice. Session idempotency records are retained for 30 days; production TTL configuration is a later Human Gate.

## Bounded public errors

Public failures use only these shapes:

| HTTP | Body |
| --- | --- |
| 400 | `{ "error": "INVALID_REQUEST" }` |
| 401 | `{ "error": "UNAUTHORIZED" }` |
| 403 | `{ "error": "FORBIDDEN" }` |
| 404 | `{ "error": "NOT_FOUND" }` |
| 409 | `{ "error": "CONFLICT" }` |
| 500 | `{ "error": "INTERNAL_ERROR" }` |
| 503 | `{ "error": "SERVICE_UNAVAILABLE" }` |

Internal exception messages, credentials, Firebase UIDs, raw tokens, email values from errors, request bodies, and datastore paths are not serialized into public errors.

## Environment contract

The runtime reads these variable names; this document intentionally contains no secret values.

| Variable | Purpose |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Required Firebase project identifier. |
| `STUDENT_INVITATION_BASE_URL` | Required Student App base URL used to construct fragment invitation links. |
| `FIREBASE_DATABASE_URL` | Optional explicit Realtime Database URL used by Firebase Admin. |
| `FIREBASE_APP_NAME` | Optional Firebase Admin app name. |
| `ACCOUNT_SERVICE_MODE` | Preferred service mode; falls back to `NODE_ENV`, then `development`. |
| `NODE_ENV` | Secondary mode source. |
| `PORT` | HTTP listen port; default `3000`. |
| `HOST` | HTTP listen host; default `0.0.0.0`. |
| `FIREBASE_AUTH_EMULATOR_HOST` | Firebase Auth emulator host. |
| `FIRESTORE_EMULATOR_HOST` | Firestore emulator host. |
| `FIREBASE_DATABASE_EMULATOR_HOST` | Realtime Database emulator host. |

When an emulator host is present, Firebase Admin emulator mode avoids production Application Default Credentials. Production credentials are supplied through the deployment platform/ADC rather than committed configuration.

## Local verification

```bash
npm test
npm run test:emulator
node --check src/server.js
```

The emulator scripts use the demo project ID `demo-st-student-account`; they do not require production Firebase credentials.
