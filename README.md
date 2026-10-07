# st-student-account-service

Shared student-management service for ST Student and SesliTab.

## V1 scope

- teacher-generated, single-use invitation links;
- Firebase-authenticated invitation acceptance;
- stable teacher/student relationship activation behind a Secure Delivery authority port;
- privacy-minimized session counts;
- Realtime Database presence read model;
- teacher-scoped Student Management read model.

The service does **not** replace Firebase Authentication, ST Student login, SesliTab Secure Delivery, assignment delivery, or offline score storage.

## Runtime

Node.js 24, Express 4, Firebase Admin SDK 14, Cloud Firestore, Firebase Realtime Database.

Required runtime variables:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_DATABASE_URL`
- `INVITATION_BASE_URL`
- `PORT` (optional, default `8787`)

For local emulators, Firebase CLI supplies/uses:

- `FIRESTORE_EMULATOR_HOST`
- `FIREBASE_AUTH_EMULATOR_HOST`
- `FIREBASE_DATABASE_EMULATOR_HOST`

Do not place service-account JSON, private keys, Firebase ID tokens, or raw invitation tokens in this repository.

## Verification

```bash
npm install --no-audit --no-fund
npm test
npm run test:emulator
node --check src/server.js
```

Emulator tests use only the demo project `demo-st-student-account`; no production Firebase credentials are required.

## Current safety boundary

Production deployment is intentionally blocked until a separately approved `SecureDeliveryAuthorityPort` adapter binds this service to the existing SesliTab Secure Delivery identity/grant authority. ST Student and SesliTab source integrations are also separate Human Gates.
