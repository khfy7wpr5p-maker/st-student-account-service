# st-student-account-service

Standalone V1 backend for ST Student / SesliTab student management.

## Scope

This service owns the student-management orchestration boundary for:

- teacher-created invitation links;
- student invitation resolution and acceptance;
- stable student account and teacher-student relationship state;
- privacy-minimized application-session counts;
- trusted Realtime Database presence readout;
- teacher-scoped Student Management read model.

It does **not** replace Firebase Authentication or the existing SesliTab Secure Delivery assignment authority.

## Runtime

- Node.js 24
- Express 4.21.x
- Firebase Admin SDK 14.4.x
- Firestore
- Firebase Realtime Database

Start:

```bash
npm start
```

Development watch mode:

```bash
npm run dev
```

Required runtime configuration names:

- `FIREBASE_PROJECT_ID`
- `STUDENT_INVITATION_BASE_URL`

Optional/runtime-specific names:

- `FIREBASE_DATABASE_URL`
- `FIREBASE_APP_NAME`
- `ACCOUNT_SERVICE_MODE` or `NODE_ENV`
- `PORT`
- `HOST`
- `FIREBASE_AUTH_EMULATOR_HOST`
- `FIRESTORE_EMULATOR_HOST`
- `FIREBASE_DATABASE_EMULATOR_HOST`

Do not commit production credentials or service-account JSON. Emulator execution uses Firebase demo project configuration and does not require production credentials.

## Verification

```bash
npm test
npm run test:emulator
git diff --check
node --check src/server.js
```

`npm test` runs unit + contract tests. `npm run test:emulator` runs Firestore/Auth and Realtime Database/Auth emulator suites.

## API

See [`docs/api-v1.md`](docs/api-v1.md) for the exact bounded V1 HTTP contract.

Health endpoint:

```text
GET /health
```

The health response is intentionally provider-neutral and contains no credential/configuration details.

## Integration status

The backend V1 is intentionally stopped before production/cross-repository integration.

See [`docs/integration-handoff.md`](docs/integration-handoff.md) for the Human-Gate work covering:

- ST Student invitation/account flow;
- ST Student RTDB presence writer and usage-session hook;
- SesliTab Student Management UI/client;
- production `SecureDeliveryAuthorityPort` binding;
- production Firebase rules/index/TTL changes;
- deploy and merge.

Until those gates are explicitly approved, this repository must not be treated as authorization to change `st-student-app`, `seslitab-guitar-reader`, production Firebase, or Secure Delivery production authority.

## Privacy and authority invariants

- Passwords never enter this service.
- Raw Firebase ID tokens and raw invitation tokens are not logged.
- Firebase UID remains server-private and is not a stable domain `studentId`/`teacherId`.
- Presence and usage are informational only and never grant assignment authority.
- Direct browser access to account-service-owned private Firestore collections is denied.
- Production startup requires an explicitly configured `SecureDeliveryAuthorityPort`; development/emulator activation remains fail-closed when it is absent.
