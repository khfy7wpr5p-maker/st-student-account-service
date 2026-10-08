export function createInMemoryStudentAccountRepository(initialRecords = []) {
  const byUid = new Map()
  const byStudentId = new Map()
  for (const record of initialRecords) {
    byUid.set(record.firebaseUid, record)
    byStudentId.set(record.studentId, record)
  }

  return Object.freeze({
    async findByFirebaseUid(uid) {
      return byUid.get(uid) ?? null
    },
    async getByStudentId(studentId) {
      return byStudentId.get(studentId) ?? null
    },
    async createActivating(record) {
      const uidExisting = byUid.get(record.firebaseUid)
      if (uidExisting) {
        if (JSON.stringify(uidExisting) === JSON.stringify(record)) return uidExisting
        throw new Error('student-account-conflict')
      }
      if (byStudentId.has(record.studentId)) throw new Error('student-id-conflict')
      byUid.set(record.firebaseUid, record)
      byStudentId.set(record.studentId, record)
      return record
    },
    async markActive(studentId) {
      const current = byStudentId.get(studentId)
      if (!current) throw new Error('student-account-not-found')
      if (current.active) return current
      const next = Object.freeze({ ...current, active: true })
      byStudentId.set(studentId, next)
      byUid.set(next.firebaseUid, next)
      return next
    },
    snapshot() {
      return [...byStudentId.values()]
    },
  })
}
