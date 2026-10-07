# Integration Handoff — Human Gates

Completion of this repository is **not** authorization for cross-repository or production actions.

## Gate A — ST Student invitation/account route
Later work must read the invitation token from the URL fragment, use Firebase Web SDK directly for account creation/sign-in, never send a password to account-service, and preserve the normal login screen.

## Gate B — ST Student presence and usage hooks
Later work must use `.info/connected` + `onDisconnect()`, own-UID presence writes, one usage session per authenticated boot, and preserve offline practice if presence is unavailable.

## Gate C — SesliTab Student Management UI
Later work may expose invitation creation/copy/revoke and render INVITED / ACTIVATING / ACTIVE / INACTIVE plus informational presence/usage. Ödev Gönder authorization stays on stable `studentId` and active roster authority.

## Gate D — Secure Delivery authority adapter
Production `SecureDeliveryAuthorityPort` must bind to the existing SesliTab Secure Delivery provisioning/identity/grant contract, never a parallel authority model. Required acknowledgement: `studentId`, `teacherId`, `identityActive=true`, `grantActive=true`. `ACTIVATING` is never assignment-authorized.

## Gate E — production Firebase / operations
Separate approval is required before production Firestore/RTDB rules or indexes deployment, TTL activation, identity migration, secret/service-account addition, hosting/service creation, deploy, or merge.
