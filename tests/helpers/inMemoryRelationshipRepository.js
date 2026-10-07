import { activateTeacherStudentRelationship } from '../../src/domain/teacherStudentRelationship.js'

export function createInMemoryRelationshipRepository(initialRecords = []) {
  const byId = new Map()
  const bySourceInviteId = new Map()
  for (const record of initialRecords) {
    byId.set(record.relationshipId, record)
    bySourceInviteId.set(record.sourceInviteId, record)
  }

  return Object.freeze({
    async getBySourceInviteId(inviteId) {
      return bySourceInviteId.get(inviteId) ?? null
    },
    async beginActivation(record) {
      const existing = bySourceInviteId.get(record.sourceInviteId)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(record)) return existing
        throw new Error('relationship-conflict')
      }
      if (byId.has(record.relationshipId)) throw new Error('relationship-id-conflict')
      byId.set(record.relationshipId, record)
      bySourceInviteId.set(record.sourceInviteId, record)
      return record
    },
    async markActive(relationshipId, activatedAt) {
      const current = byId.get(relationshipId)
      if (!current) throw new Error('relationship-not-found')
      if (current.active) return current
      const next = activateTeacherStudentRelationship(current, activatedAt)
      byId.set(relationshipId, next)
      bySourceInviteId.set(next.sourceInviteId, next)
      return next
    },
    snapshot() {
      return [...byId.values()]
    },
  })
}
