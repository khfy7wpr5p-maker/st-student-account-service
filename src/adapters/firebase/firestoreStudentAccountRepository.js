import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

function requireDb(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore db is required.')
  }
  return db
}

function mappingId(firebaseUid) {
  return createHash('sha256').update(firebaseUid).digest('hex')
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
  if (!record || typeof record !== 'object') throw new TypeError('student account record is required.')
  if (typeof record.studentId !== 'string' || record.studentId.length === 0) throw new TypeError('studentId is required.')
  if (typeof record.firebaseUid !== 'string' || record.firebaseUid.length === 0) throw new TypeError('firebaseUid is required.')
  return record
}

export function createFirestoreStudentAccountRepository({ db } = {}) {
  const firestore = requireDb(db)
  const accounts = firestore.collection('studentAccounts')
  const uidMappings = firestore.collection('studentAccountUidMappings')

  return Object.freeze({
    async findByFirebaseUid(firebaseUid) {
      const mappingSnapshot = await uidMappings.doc(mappingId(firebaseUid)).get()
      if (!mappingSnapshot.exists) return null
      const studentId = mappingSnapshot.get('studentId')
      if (typeof studentId !== 'string' || studentId.length === 0) throw new Error('student-account-conflict')
      const account = snapshotRecord(await accounts.doc(studentId).get())
      if (!account || account.firebaseUid !== firebaseUid) throw new Error('student-account-conflict')
      return account
    },

    async createActivating(record) {
      assertRecord(record)
      const accountRef = accounts.doc(record.studentId)
      const mappingRef = uidMappings.doc(mappingId(record.firebaseUid))

      return firestore.runTransaction(async (transaction) => {
        const mappingSnapshot = await transaction.get(mappingRef)
        const accountSnapshot = await transaction.get(accountRef)
        const existingAccount = snapshotRecord(accountSnapshot)

        if (mappingSnapshot.exists) {
          const mappedStudentId = mappingSnapshot.get('studentId')
          if (mappedStudentId !== record.studentId || !existingAccount || !isDeepStrictEqual(existingAccount, record)) {
            throw new Error('student-account-conflict')
          }
          return existingAccount
        }

        if (existingAccount) {
          if (!isDeepStrictEqual(existingAccount, record)) throw new Error('student-account-conflict')
          transaction.create(mappingRef, { studentId: record.studentId })
          return existingAccount
        }

        transaction.create(accountRef, { ...record })
        transaction.create(mappingRef, { studentId: record.studentId })
        return Object.freeze({ ...record })
      })
    },

    async markActive(studentId) {
      const accountRef = accounts.doc(studentId)
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(accountRef)
        const current = snapshotRecord(snapshot)
        if (!current) throw new Error('student-account-not-found')
        if (current.active === true) return current
        const next = Object.freeze({ ...current, active: true })
        transaction.set(accountRef, { ...next })
        return next
      })
    },
  })
}
