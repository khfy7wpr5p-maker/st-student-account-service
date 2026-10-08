import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { activateTeacherStudentRelationship } from '../../domain/teacherStudentRelationship.js'

function requireDb(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore db is required.')
  }
  return db
}

function mappingId(sourceInviteId) {
  return createHash('sha256').update(sourceInviteId).digest('hex')
}

function toProviderNeutral(value) {
  if (value === null || value === undefined) return value
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(toProviderNeutral)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toProviderNeutral(child)]))
  }
  return value
}

function snapshotRecord(snapshot) {
  if (!snapshot.exists) return null
  return Object.freeze(toProviderNeutral(snapshot.data()))
}

function assertRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('relationship record is required.')
  if (typeof record.relationshipId !== 'string' || record.relationshipId.length === 0) throw new TypeError('relationshipId is required.')
  if (typeof record.sourceInviteId !== 'string' || record.sourceInviteId.length === 0) throw new TypeError('sourceInviteId is required.')
  return record
}

export function createFirestoreRelationshipRepository({ db } = {}) {
  const firestore = requireDb(db)
  const relationships = firestore.collection('teacherStudentRelationships')
  const sourceMappings = firestore.collection('teacherStudentRelationshipSources')

  return Object.freeze({
    async beginActivation(record) {
      assertRecord(record)
      const relationshipRef = relationships.doc(record.relationshipId)
      const mappingRef = sourceMappings.doc(mappingId(record.sourceInviteId))

      return firestore.runTransaction(async (transaction) => {
        const mappingSnapshot = await transaction.get(mappingRef)
        const relationshipSnapshot = await transaction.get(relationshipRef)
        const existingRelationship = snapshotRecord(relationshipSnapshot)

        if (mappingSnapshot.exists) {
          const mappedRelationshipId = mappingSnapshot.get('relationshipId')
          if (
            mappedRelationshipId !== record.relationshipId ||
            !existingRelationship ||
            !isDeepStrictEqual(existingRelationship, record)
          ) {
            throw new Error('relationship-conflict')
          }
          return existingRelationship
        }

        if (existingRelationship) {
          if (!isDeepStrictEqual(existingRelationship, record)) throw new Error('relationship-conflict')
          transaction.create(mappingRef, { relationshipId: record.relationshipId })
          return existingRelationship
        }

        transaction.create(relationshipRef, { ...record })
        transaction.create(mappingRef, { relationshipId: record.relationshipId })
        return Object.freeze({ ...record })
      })
    },

    async markActive(relationshipId, activatedAt) {
      const relationshipRef = relationships.doc(relationshipId)
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(relationshipRef)
        const current = snapshotRecord(snapshot)
        if (!current) throw new Error('relationship-not-found')
        if (current.active === true) return current
        const next = activateTeacherStudentRelationship(current, activatedAt)
        transaction.set(relationshipRef, { ...next })
        return next
      })
    },

    async getBySourceInviteId(sourceInviteId) {
      const mappingSnapshot = await sourceMappings.doc(mappingId(sourceInviteId)).get()
      if (!mappingSnapshot.exists) return null
      const relationshipId = mappingSnapshot.get('relationshipId')
      if (typeof relationshipId !== 'string' || relationshipId.length === 0) throw new Error('relationship-conflict')
      const relationship = snapshotRecord(await relationships.doc(relationshipId).get())
      if (!relationship || relationship.sourceInviteId !== sourceInviteId) throw new Error('relationship-conflict')
      return relationship
    },
  })
}
