import { createHash } from 'node:crypto'

import {
  normalizeRequiredId,
  normalizeTimestamp,
} from '../../domain/validation.js'

const STUDENT_ROLE = 'STUDENT'
const TEACHER_ROLE = 'TEACHER'
const OPERATOR_ID = 'st-student-account-service'
const REASON = 'Account invitation authority activation.'

function hashJson(value) {
  return createHash('sha256')
    .update(JSON.stringify(value === undefined ? null : value), 'utf8')
    .digest('hex')
}

function documentId(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function bindingId(role, stableId) {
  return Buffer.from(
    JSON.stringify([role, stableId]),
    'utf8',
  ).toString('base64url')
}

function grantId(teacherId, studentId) {
  return Buffer.from(
    JSON.stringify([teacherId, studentId]),
    'utf8',
  ).toString('base64url')
}

function operationId(sourceInviteId, action) {
  const fingerprint = createHash('sha256')
    .update(sourceInviteId, 'utf8')
    .digest('hex')
    .slice(0, 40)
  return `account-${action.toLowerCase()}-${fingerprint}`
}

function assertFirestore(db) {
  if (
    !db ||
    typeof db.collection !== 'function' ||
    typeof db.runTransaction !== 'function'
  ) {
    throw new TypeError('db must provide Firestore collection() and runTransaction().')
  }
  return db
}

function assertNormalizedTimestamp(value, fieldName, errorMessage) {
  try {
    if (normalizeTimestamp(value, fieldName) !== value) throw new Error(errorMessage)
  } catch {
    throw new Error(errorMessage)
  }
  return value
}

function assertBinding(binding, { role, stableId, providerSubject }, errorMessage) {
  if (
    !binding ||
    binding.role !== role ||
    binding.stableId !== stableId ||
    binding.providerSubject !== providerSubject
  ) {
    throw new Error(errorMessage)
  }
  return binding
}

function assertTeacherIdentity(mapping, { providerSubject, teacherId }) {
  if (
    !mapping ||
    mapping.schemaVersion !== 1 ||
    mapping.providerSubject !== providerSubject ||
    mapping.role !== TEACHER_ROLE ||
    mapping.teacherId !== teacherId ||
    mapping.studentId !== null ||
    mapping.active !== true ||
    mapping.disabledAt !== null
  ) {
    throw new Error('teacher-authority-unavailable')
  }
  assertNormalizedTimestamp(
    mapping.createdAt,
    'teacher identity createdAt',
    'teacher-authority-unavailable',
  )
  return mapping
}

function assertStudentIdentity(mapping, { firebaseUid, studentId }) {
  if (
    !mapping ||
    mapping.schemaVersion !== 1 ||
    mapping.providerSubject !== firebaseUid ||
    mapping.role !== STUDENT_ROLE ||
    mapping.teacherId !== null ||
    mapping.studentId !== studentId
  ) {
    throw new Error('student-identity-conflict')
  }
  if (mapping.active !== true || mapping.disabledAt !== null) {
    throw new Error('student-identity-disabled')
  }
  assertNormalizedTimestamp(
    mapping.createdAt,
    'student identity createdAt',
    'student-identity-conflict',
  )
  return mapping
}

function assertGrant(grant, { teacherId, studentId }) {
  if (
    !grant ||
    grant.schemaVersion !== 1 ||
    grant.teacherId !== teacherId ||
    grant.studentId !== studentId
  ) {
    throw new Error('grant-conflict')
  }
  if (grant.active !== true || grant.revokedAt !== null) {
    throw new Error('grant-revoked')
  }
  assertNormalizedTimestamp(
    grant.createdAt,
    'grant createdAt',
    'grant-conflict',
  )
  return grant
}

function normalizeActivation(input = {}) {
  return Object.freeze({
    firebaseUid: normalizeRequiredId(input.firebaseUid, 'firebaseUid'),
    teacherId: normalizeRequiredId(input.teacherId, 'teacherId'),
    studentId: normalizeRequiredId(input.studentId, 'studentId'),
    activatedAt: normalizeTimestamp(input.activatedAt, 'activatedAt'),
    sourceInviteId: normalizeRequiredId(input.sourceInviteId, 'sourceInviteId'),
  })
}

function identityCommand(activation, timestamp) {
  return Object.freeze({
    schemaVersion: 1,
    operationId: operationId(activation.sourceInviteId, 'CREATE_IDENTITY'),
    action: 'CREATE_IDENTITY',
    operatorId: OPERATOR_ID,
    reason: REASON,
    timestamp,
    providerSubject: activation.firebaseUid,
    role: STUDENT_ROLE,
    teacherId: null,
    studentId: activation.studentId,
  })
}

function grantCommand(activation, timestamp) {
  return Object.freeze({
    schemaVersion: 1,
    operationId: operationId(activation.sourceInviteId, 'CREATE_GRANT'),
    action: 'CREATE_GRANT',
    operatorId: OPERATOR_ID,
    reason: REASON,
    timestamp,
    teacherId: activation.teacherId,
    studentId: activation.studentId,
  })
}

function identityState(mapping, binding) {
  return Object.freeze({
    mapping: mapping ?? null,
    binding: binding ?? null,
  })
}

function assertAuditReplay(audit, { command, afterState, targetType, stableIdentity, providerSubject }) {
  if (
    !audit ||
    audit.schemaVersion !== 1 ||
    audit.operationId !== command.operationId ||
    audit.action !== command.action ||
    audit.targetType !== targetType ||
    audit.stableIdentity !== stableIdentity ||
    audit.providerSubject !== providerSubject ||
    audit.operatorId !== OPERATOR_ID ||
    audit.reason !== REASON ||
    audit.timestamp !== command.timestamp ||
    audit.commandFingerprint !== hashJson(command) ||
    audit.afterFingerprint !== hashJson(afterState) ||
    typeof audit.beforeFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(audit.beforeFingerprint) ||
    !['APPLIED', 'NOOP'].includes(audit.result)
  ) {
    throw new Error('secure-delivery-provisioning-audit-conflict')
  }
  return audit
}

function createAudit({ command, beforeState, afterState, result, targetType, stableIdentity, providerSubject }) {
  return Object.freeze({
    schemaVersion: 1,
    operationId: command.operationId,
    action: command.action,
    targetType,
    stableIdentity,
    providerSubject,
    operatorId: OPERATOR_ID,
    reason: REASON,
    timestamp: command.timestamp,
    commandFingerprint: hashJson(command),
    beforeFingerprint: hashJson(beforeState),
    afterFingerprint: hashJson(afterState),
    result,
  })
}

export function createFirestoreSecureDeliveryAuthorityPort({ db } = {}) {
  const firestore = assertFirestore(db)
  const identities = firestore.collection('identityMappings')
  const bindings = firestore.collection('identityDomainBindings')
  const grants = firestore.collection('teacherStudentGrants')
  const audits = firestore.collection('secureDeliveryProvisioningAudit')

  return Object.freeze({
    async activateStudent(input = {}) {
      const activation = normalizeActivation(input)
      const studentIdentityRef = identities.doc(documentId(activation.firebaseUid))
      const studentBindingRef = bindings.doc(bindingId(STUDENT_ROLE, activation.studentId))
      const teacherBindingRef = bindings.doc(bindingId(TEACHER_ROLE, activation.teacherId))
      const grantRef = grants.doc(grantId(activation.teacherId, activation.studentId))
      const identityAuditId = operationId(activation.sourceInviteId, 'CREATE_IDENTITY')
      const grantAuditId = operationId(activation.sourceInviteId, 'CREATE_GRANT')
      const identityAuditRef = audits.doc(documentId(identityAuditId))
      const grantAuditRef = audits.doc(documentId(grantAuditId))
      const stableStudentQuery = identities.where('studentId', '==', activation.studentId)

      await firestore.runTransaction(async (transaction) => {
        const [
          teacherBindingSnap,
          studentIdentitySnap,
          studentBindingSnap,
          grantSnap,
          identityAuditSnap,
          grantAuditSnap,
          stableStudentSnaps,
        ] = await Promise.all([
          transaction.get(teacherBindingRef),
          transaction.get(studentIdentityRef),
          transaction.get(studentBindingRef),
          transaction.get(grantRef),
          transaction.get(identityAuditRef),
          transaction.get(grantAuditRef),
          transaction.get(stableStudentQuery),
        ])

        if (!teacherBindingSnap.exists) {
          throw new Error('teacher-authority-unavailable')
        }
        const teacherBinding = teacherBindingSnap.data()
        if (
          !teacherBinding ||
          teacherBinding.role !== TEACHER_ROLE ||
          teacherBinding.stableId !== activation.teacherId ||
          typeof teacherBinding.providerSubject !== 'string' ||
          !teacherBinding.providerSubject.trim()
        ) {
          throw new Error('teacher-authority-unavailable')
        }

        const teacherIdentityRef = identities.doc(documentId(teacherBinding.providerSubject))
        const teacherIdentitySnap = await transaction.get(teacherIdentityRef)
        if (!teacherIdentitySnap.exists) {
          throw new Error('teacher-authority-unavailable')
        }
        assertTeacherIdentity(teacherIdentitySnap.data(), {
          providerSubject: teacherBinding.providerSubject,
          teacherId: activation.teacherId,
        })
        assertBinding(
          teacherBinding,
          {
            role: TEACHER_ROLE,
            stableId: activation.teacherId,
            providerSubject: teacherBinding.providerSubject,
          },
          'teacher-authority-unavailable',
        )

        for (const candidate of stableStudentSnaps.docs) {
          const data = candidate.data()
          if (data?.providerSubject !== activation.firebaseUid) {
            throw new Error('student-identity-conflict')
          }
        }

        const existingStudentIdentity = studentIdentitySnap.exists
          ? assertStudentIdentity(studentIdentitySnap.data(), activation)
          : null
        const existingStudentBinding = studentBindingSnap.exists
          ? assertBinding(
              studentBindingSnap.data(),
              {
                role: STUDENT_ROLE,
                stableId: activation.studentId,
                providerSubject: activation.firebaseUid,
              },
              'student-identity-conflict',
            )
          : null
        const existingGrant = grantSnap.exists
          ? assertGrant(grantSnap.data(), activation)
          : null

        const identityTimestamp = existingStudentIdentity?.createdAt ?? activation.activatedAt
        const grantTimestamp = existingGrant?.createdAt ?? activation.activatedAt
        const identity = existingStudentIdentity ?? {
          schemaVersion: 1,
          providerSubject: activation.firebaseUid,
          role: STUDENT_ROLE,
          teacherId: null,
          studentId: activation.studentId,
          active: true,
          createdAt: identityTimestamp,
          disabledAt: null,
        }
        const studentBinding = existingStudentBinding ?? {
          role: STUDENT_ROLE,
          stableId: activation.studentId,
          providerSubject: activation.firebaseUid,
        }
        const grant = existingGrant ?? {
          schemaVersion: 1,
          teacherId: activation.teacherId,
          studentId: activation.studentId,
          active: true,
          createdAt: grantTimestamp,
          revokedAt: null,
        }

        const identityBefore = identityState(existingStudentIdentity, existingStudentBinding)
        const identityAfter = identityState(identity, studentBinding)
        const grantBefore = existingGrant
        const grantAfter = grant
        const createIdentity = identityCommand(activation, identityTimestamp)
        const createGrant = grantCommand(activation, grantTimestamp)

        if (identityAuditSnap.exists) {
          assertAuditReplay(identityAuditSnap.data(), {
            command: createIdentity,
            afterState: identityAfter,
            targetType: 'IDENTITY',
            stableIdentity: `STUDENT:${activation.studentId}`,
            providerSubject: activation.firebaseUid,
          })
        }
        if (grantAuditSnap.exists) {
          assertAuditReplay(grantAuditSnap.data(), {
            command: createGrant,
            afterState: grantAfter,
            targetType: 'GRANT',
            stableIdentity: `TEACHER:${activation.teacherId}->STUDENT:${activation.studentId}`,
            providerSubject: null,
          })
        }

        if (!studentIdentitySnap.exists) transaction.set(studentIdentityRef, identity)
        if (!studentBindingSnap.exists) transaction.set(studentBindingRef, studentBinding)
        if (!grantSnap.exists) transaction.set(grantRef, grant)

        if (!identityAuditSnap.exists) {
          transaction.set(
            identityAuditRef,
            createAudit({
              command: createIdentity,
              beforeState: identityBefore,
              afterState: identityAfter,
              result:
                existingStudentIdentity && existingStudentBinding
                  ? 'NOOP'
                  : 'APPLIED',
              targetType: 'IDENTITY',
              stableIdentity: `STUDENT:${activation.studentId}`,
              providerSubject: activation.firebaseUid,
            }),
          )
        }
        if (!grantAuditSnap.exists) {
          transaction.set(
            grantAuditRef,
            createAudit({
              command: createGrant,
              beforeState: grantBefore,
              afterState: grantAfter,
              result: existingGrant ? 'NOOP' : 'APPLIED',
              targetType: 'GRANT',
              stableIdentity: `TEACHER:${activation.teacherId}->STUDENT:${activation.studentId}`,
              providerSubject: null,
            }),
          )
        }
      })

      return Object.freeze({
        studentId: activation.studentId,
        teacherId: activation.teacherId,
        identityActive: true,
        grantActive: true,
      })
    },
  })
}
