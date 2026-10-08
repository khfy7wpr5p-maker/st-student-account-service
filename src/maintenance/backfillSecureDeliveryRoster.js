function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`)
  }
  return value
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`backfill-${name}-invalid`)
  }
  return value.trim()
}

function assertRelationship(record) {
  if (!record || typeof record !== 'object' || record.active !== true) {
    throw new Error('backfill-relationship-invalid')
  }
  return Object.freeze({
    teacherId: requireText(record.teacherId, 'teacher-id'),
    studentId: requireText(record.studentId, 'student-id'),
    displayNameOrNickname: requireText(record.displayNameOrNickname, 'display-name'),
    activatedAt: requireText(record.activatedAt, 'activated-at'),
    sourceInviteId: requireText(record.sourceInviteId, 'source-invite-id'),
  })
}

function assertAccount(account, studentId) {
  if (
    !account ||
    typeof account !== 'object' ||
    account.active !== true ||
    account.studentId !== studentId ||
    typeof account.firebaseUid !== 'string' ||
    !account.firebaseUid.trim()
  ) {
    throw new Error('backfill-student-account-unavailable')
  }
  return Object.freeze({
    studentId,
    firebaseUid: account.firebaseUid.trim(),
  })
}

function assertAcknowledgement(result, expected) {
  if (
    !result ||
    result.studentId !== expected.studentId ||
    result.teacherId !== expected.teacherId ||
    result.identityActive !== true ||
    result.grantActive !== true
  ) {
    throw new Error('backfill-authority-ack-mismatch')
  }
}

export async function backfillSecureDeliveryRoster({
  listActiveRelationships,
  getStudentAccount,
  hasRosterEntry,
  activateStudent,
} = {}) {
  const listRelationships = requireFunction(
    listActiveRelationships,
    'listActiveRelationships',
  )
  const getAccount = requireFunction(
    getStudentAccount,
    'getStudentAccount',
  )
  const rosterExists = requireFunction(
    hasRosterEntry,
    'hasRosterEntry',
  )
  const activate = requireFunction(
    activateStudent,
    'activateStudent',
  )

  const records = await listRelationships()
  if (!Array.isArray(records)) {
    throw new TypeError('listActiveRelationships must return an array.')
  }

  let repaired = 0
  let skipped = 0

  for (const raw of records) {
    const relationship = assertRelationship(raw)
    if (await rosterExists(relationship.studentId)) {
      skipped += 1
      continue
    }

    const account = assertAccount(
      await getAccount(relationship.studentId),
      relationship.studentId,
    )
    const input = Object.freeze({
      firebaseUid: account.firebaseUid,
      teacherId: relationship.teacherId,
      studentId: relationship.studentId,
      displayNameOrNickname: relationship.displayNameOrNickname,
      activatedAt: relationship.activatedAt,
      sourceInviteId: relationship.sourceInviteId,
    })
    const acknowledgement = await activate(input)
    assertAcknowledgement(acknowledgement, input)
    repaired += 1
  }

  return Object.freeze({
    scanned: records.length,
    repaired,
    skipped,
  })
}
