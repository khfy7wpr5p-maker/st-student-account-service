import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

function requireDb(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore db is required.')
  }
  return db
}

function lockId(teacherId, emailNormalized) {
  return createHash('sha256').update(`${teacherId}\u0000${emailNormalized}`).digest('hex')
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
  if (!record || typeof record !== 'object') throw new TypeError('invitation record is required.')
  if (typeof record.inviteId !== 'string' || record.inviteId.length === 0) throw new TypeError('inviteId is required.')
  if (typeof record.teacherId !== 'string' || record.teacherId.length === 0) throw new TypeError('teacherId is required.')
  if (typeof record.emailNormalized !== 'string' || record.emailNormalized.length === 0) throw new TypeError('emailNormalized is required.')
  return record
}

export function createFirestoreInvitationRepository({ db } = {}) {
  const firestore = requireDb(db)
  const invitations = firestore.collection('studentInvitations')
  const pendingLocks = firestore.collection('studentInvitationPendingLocks')

  return Object.freeze({
    async create(record) {
      assertRecord(record)
      if (record.status !== 'PENDING') throw new Error('invitation-create-conflict')
      const invitationRef = invitations.doc(record.inviteId)
      const pendingRef = pendingLocks.doc(lockId(record.teacherId, record.emailNormalized))

      return firestore.runTransaction(async (transaction) => {
        const invitationSnapshot = await transaction.get(invitationRef)
        const pendingSnapshot = await transaction.get(pendingRef)

        const existing = snapshotRecord(invitationSnapshot)
        if (existing) {
          if (isDeepStrictEqual(existing, record)) return existing
          throw new Error('invitation-create-conflict')
        }
        if (pendingSnapshot.exists) throw new Error('pending-invitation-conflict')

        transaction.create(invitationRef, { ...record })
        transaction.create(pendingRef, {
          inviteId: record.inviteId,
          teacherId: record.teacherId,
          emailNormalized: record.emailNormalized,
        })
        return Object.freeze({ ...record })
      })
    },

    async findPendingByTeacherAndEmail(teacherId, emailNormalized) {
      const pendingSnapshot = await pendingLocks.doc(lockId(teacherId, emailNormalized)).get()
      if (!pendingSnapshot.exists) return null
      const inviteId = pendingSnapshot.get('inviteId')
      if (typeof inviteId !== 'string' || inviteId.length === 0) throw new Error('pending-invitation-conflict')
      const invitation = snapshotRecord(await invitations.doc(inviteId).get())
      if (!invitation) throw new Error('pending-invitation-conflict')
      if (
        invitation.status !== 'PENDING' ||
        invitation.teacherId !== teacherId ||
        invitation.emailNormalized !== emailNormalized
      ) {
        return null
      }
      return invitation
    },

    async findByTokenHash(tokenHash) {
      const snapshot = await invitations.where('tokenHash', '==', tokenHash).limit(2).get()
      if (snapshot.empty) return null
      if (snapshot.size !== 1) throw new Error('invitation-token-conflict')
      return snapshotRecord(snapshot.docs[0])
    },

    async listByTeacherId(teacherId) {
      const snapshot = await invitations.where('teacherId', '==', teacherId).get()
      return Object.freeze(snapshot.docs.map(snapshotRecord))
    },

    async getById(inviteId) {
      return snapshotRecord(await invitations.doc(inviteId).get())
    },

    async replace(expectedRecord, nextRecord) {
      assertRecord(expectedRecord)
      assertRecord(nextRecord)
      if (expectedRecord.inviteId !== nextRecord.inviteId) throw new Error('invitation-optimistic-conflict')
      if (expectedRecord.status !== 'PENDING' && nextRecord.status === 'PENDING') {
        throw new Error('invitation-optimistic-conflict')
      }

      const invitationRef = invitations.doc(expectedRecord.inviteId)
      const pendingRef = pendingLocks.doc(lockId(expectedRecord.teacherId, expectedRecord.emailNormalized))

      return firestore.runTransaction(async (transaction) => {
        const invitationSnapshot = await transaction.get(invitationRef)
        const pendingSnapshot = expectedRecord.status === 'PENDING'
          ? await transaction.get(pendingRef)
          : null
        const current = snapshotRecord(invitationSnapshot)

        if (!current || !isDeepStrictEqual(current, expectedRecord)) {
          throw new Error('invitation-optimistic-conflict')
        }
        if (
          expectedRecord.status === 'PENDING' &&
          (!pendingSnapshot?.exists || pendingSnapshot.get('inviteId') !== expectedRecord.inviteId)
        ) {
          throw new Error('invitation-optimistic-conflict')
        }

        transaction.set(invitationRef, { ...nextRecord })
        if (expectedRecord.status === 'PENDING' && nextRecord.status !== 'PENDING') {
          transaction.delete(pendingRef)
        }
        return Object.freeze({ ...nextRecord })
      })
    },
  })
}
