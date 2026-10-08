import { Timestamp } from 'firebase-admin/firestore'

import { createStudentUsageSession, createStudentUsageSummary } from '../../domain/studentUsage.js'

function requireDb(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore db is required.')
  }
  return db
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

function asTimestamp(isoTimestamp) {
  return Timestamp.fromDate(new Date(isoTimestamp))
}

function summaryFromSnapshot(snapshot, studentId) {
  if (!snapshot.exists) return null
  const data = toProviderNeutral(snapshot.data())
  const summary = createStudentUsageSummary({
    studentId: data.studentId,
    totalSessions: data.totalSessions,
    lastSessionAt: data.lastSessionAt,
  })
  if (summary.studentId !== studentId) throw new Error('student-usage-conflict')
  return summary
}

function sessionFromSnapshot(snapshot, expected) {
  if (!snapshot.exists) return null
  const data = toProviderNeutral(snapshot.data())
  const stored = createStudentUsageSession({
    studentId: data.studentId,
    clientSessionId: data.clientSessionId,
    startedAt: data.startedAt,
    expiresAt: data.expiresAt,
  })
  if (
    stored.studentId !== expected.studentId ||
    stored.clientSessionId !== expected.clientSessionId
  ) {
    throw new Error('student-usage-conflict')
  }
  return stored
}

function summaryData(summary) {
  return {
    schemaVersion: summary.schemaVersion,
    studentId: summary.studentId,
    totalSessions: summary.totalSessions,
    lastSessionAt: summary.lastSessionAt === null ? null : asTimestamp(summary.lastSessionAt),
  }
}

function sessionData(session) {
  return {
    schemaVersion: session.schemaVersion,
    studentId: session.studentId,
    clientSessionId: session.clientSessionId,
    startedAt: asTimestamp(session.startedAt),
    expiresAt: asTimestamp(session.expiresAt),
  }
}

function acknowledgement(isNew, summary) {
  return Object.freeze({
    isNew,
    totalSessions: summary.totalSessions,
    lastSessionAt: summary.lastSessionAt,
  })
}

export function createFirestoreUsageRepository({ db } = {}) {
  const firestore = requireDb(db)
  const usage = firestore.collection('studentUsage')

  return Object.freeze({
    async getSummary(studentId) {
      return summaryFromSnapshot(await usage.doc(studentId).get(), studentId)
    },

    async recordSessionOnce(input) {
      const session = createStudentUsageSession(input)
      const summaryRef = usage.doc(session.studentId)
      const sessionRef = summaryRef.collection('sessions').doc(session.clientSessionId)

      return firestore.runTransaction(async (transaction) => {
        const sessionSnapshot = await transaction.get(sessionRef)
        const summarySnapshot = await transaction.get(summaryRef)
        const existingSession = sessionFromSnapshot(sessionSnapshot, session)
        const existingSummary = summaryFromSnapshot(summarySnapshot, session.studentId)

        if (existingSession) {
          if (!existingSummary) throw new Error('student-usage-conflict')
          return acknowledgement(false, existingSummary)
        }

        const nextSummary = createStudentUsageSummary({
          studentId: session.studentId,
          totalSessions: (existingSummary?.totalSessions ?? 0) + 1,
          lastSessionAt: session.startedAt,
        })

        transaction.create(sessionRef, sessionData(session))
        if (existingSummary) {
          transaction.set(summaryRef, summaryData(nextSummary))
        } else {
          transaction.create(summaryRef, summaryData(nextSummary))
        }

        return acknowledgement(true, nextSummary)
      })
    },
  })
}
