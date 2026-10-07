export function createInMemoryInvitationRepository(initialRecords = []) {
  const records = new Map()
  for (const record of initialRecords) records.set(record.inviteId, record)

  function sameRecord(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  return Object.freeze({
    async create(record) {
      if (records.has(record.inviteId)) throw new Error('invitation-id-conflict')
      const existing = [...records.values()].find((candidate) =>
        candidate.status === 'PENDING' &&
        candidate.teacherId === record.teacherId &&
        candidate.emailNormalized === record.emailNormalized,
      )
      if (existing) throw new Error('pending-invitation-conflict')
      records.set(record.inviteId, record)
      return record
    },

    async findPendingByTeacherAndEmail(teacherId, emailNormalized) {
      return [...records.values()].find((record) =>
        record.status === 'PENDING' &&
        record.teacherId === teacherId &&
        record.emailNormalized === emailNormalized,
      ) ?? null
    },

    async findByTokenHash(tokenHash) {
      const matches = [...records.values()].filter((record) => record.tokenHash === tokenHash)
      if (matches.length > 1) throw new Error('ambiguous-invitation-token')
      return matches[0] ?? null
    },

    async getById(inviteId) {
      return records.get(inviteId) ?? null
    },

    async replace(expectedRecord, nextRecord) {
      const current = records.get(expectedRecord.inviteId)
      if (!current || !sameRecord(current, expectedRecord)) throw new Error('optimistic-conflict')
      if (nextRecord.inviteId !== expectedRecord.inviteId) throw new Error('invite-id-cannot-change')
      records.set(nextRecord.inviteId, nextRecord)
      return nextRecord
    },

    unsafeSeed(record) {
      records.set(record.inviteId, record)
    },

    snapshot() {
      return [...records.values()]
    },
  })
}
