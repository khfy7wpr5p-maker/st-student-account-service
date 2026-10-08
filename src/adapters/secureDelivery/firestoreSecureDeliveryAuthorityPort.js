import {
  normalizeRequiredId,
  normalizeTimestamp,
} from '../../domain/validation.js'

const STUDENT_ROLE = 'STUDENT'
const TEACHER_ROLE = 'TEACHER'

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
  return mapping
}

function assertStudentIdentity(mapping, { firebaseUid, studentId }) {
  if (
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
  return mapping
}

function assertGrant(grant, { teacherId, studentId }) {
  if (
    grant.schemaVersion !== 1 ||
    grant.teacherId !== teacherId ||
    grant.studentId !== studentId
  ) {
    throw new Error('grant-conflict')
  }
  if (grant.active !== true || grant.revokedAt !== null) {
    throw new Error('grant-revoked')
  }
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

export function createFirestoreSecureDeliveryAuthorityPort({ db } = {}) {
  const firestore = assertFirestore(db)
  const identities = firestore.collection('identityMappings')
  const bindings = firestore.collection('identityDomainBindings')
  const grants = firestore.collection('teacherStudentGrants')

  return Object.freeze({
    async activateStudent(input = {}) {
      const activation = normalizeActivation(input)
      const studentIdentityRef = identities.doc(documentId(activation.firebaseUid))
      const studentBindingRef = bindings.doc(bindingId(STUDENT_ROLE, activation.studentId))
      const teacherBindingRef = bindings.doc(bindingId(TEACHER_ROLE, activation.teacherId))
      const grantRef = grants.doc(grantId(activation.teacherId, activation.studentId))

      await firestore.runTransaction(async (transaction) => {
        const [teacherBindingSnap, studentIdentitySnap, studentBindingSnap, grantSnap] =
          await Promise.all([
            transaction.get(teacherBindingRef),
            transaction.get(studentIdentityRef),
            transaction.get(studentBindingRef),
            transaction.get(grantRef),
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

        if (studentIdentitySnap.exists) {
          assertStudentIdentity(studentIdentitySnap.data(), activation)
        }
        if (studentBindingSnap.exists) {
          assertBinding(
            studentBindingSnap.data(),
            {
              role: STUDENT_ROLE,
              stableId: activation.studentId,
              providerSubject: activation.firebaseUid,
            },
            'student-identity-conflict',
          )
        }
        if (grantSnap.exists) {
          assertGrant(grantSnap.data(), activation)
        }

        if (!studentIdentitySnap.exists) {
          transaction.set(studentIdentityRef, {
            schemaVersion: 1,
            providerSubject: activation.firebaseUid,
            role: STUDENT_ROLE,
            teacherId: null,
            studentId: activation.studentId,
            active: true,
            createdAt: activation.activatedAt,
            disabledAt: null,
          })
        }
        if (!studentBindingSnap.exists) {
          transaction.set(studentBindingRef, {
            role: STUDENT_ROLE,
            stableId: activation.studentId,
            providerSubject: activation.firebaseUid,
          })
        }
        if (!grantSnap.exists) {
          transaction.set(grantRef, {
            schemaVersion: 1,
            teacherId: activation.teacherId,
            studentId: activation.studentId,
            active: true,
            createdAt: activation.activatedAt,
            revokedAt: null,
          })
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
