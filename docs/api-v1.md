# Student Account Service API v1

Base path: `/api/student-accounts/v1`

All authenticated endpoints use a Firebase ID token as `Authorization: Bearer <token>`. Tokens are never returned in API bodies or logs.

## Teacher

### `POST /teacher/invitations`
Creates one pending invitation for the authenticated teacher. Body: `{"email":"student@example.com","displayNameOrNickname":"Ayşe"}`. The success response includes the raw invitation link exactly once. Only the SHA-256 token fingerprint is persisted.

### `POST /teacher/invitations/:inviteId/revoke`
Revokes a pending invitation owned by the authenticated teacher.

### `GET /teacher/students`
Returns `managementId`, nullable `studentId`, `displayNameOrNickname`, state (`INVITED|ACTIVATING|ACTIVE|INACTIVE`), invitation status, presence state (`ONLINE|OFFLINE|UNKNOWN`), last-online/last-session timestamps, and total sessions. Firebase UID, raw invitation token, Firestore paths, and credential/provider details are not returned.

## Public invitation resolution

### `POST /public/invitations/resolve`
Body: `{"inviteToken":"<raw-token-from-url-fragment>"}`. A valid response contains only `inviteId`, display name/nickname, invited email, `expiresAt`, and `accountMode: CREATE | SIGN_IN`.

## Student

### `POST /student/invitations/accept`
Requires Firebase authentication. The authenticated Firebase email must match the invitation email after normalization. Passwords never pass through this service.

### `POST /student/sessions`
Body: `{"clientSessionId":"<bounded-random-session-id>"}`. A client session is one authenticated ST Student application boot/page lifecycle. Same-ID retries are idempotent.

## Health
`GET /health` returns only `{"service":"st-student-account-service","status":"ok"}`.

## Bounded errors
Public errors use bounded codes such as `INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, and `INTERNAL_ERROR`. Raw provider messages, tokens, UIDs, database paths, and stack traces are not returned.
