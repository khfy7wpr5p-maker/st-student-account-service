import { normalizeRequiredId } from '../../domain/validation.js'

const INVALID_RTDB_KEY = /[.#$\[\]\/]/

function requireDatabase(database) {
  if (!database || typeof database !== 'object' || typeof database.ref !== 'function') {
    throw new TypeError('Realtime Database is required.')
  }
  return database
}

function normalizeFirebaseUid(value) {
  const normalized = normalizeRequiredId(value, 'firebaseUid')
  if (INVALID_RTDB_KEY.test(normalized)) {
    throw new TypeError('firebaseUid must be path-safe.')
  }
  return normalized
}

function normalizeLastOnlineAt(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function presenceState(value) {
  const connections = value && typeof value === 'object' && !Array.isArray(value)
    ? value.connections
    : null
  if (!connections || typeof connections !== 'object' || Array.isArray(connections)) {
    return 'OFFLINE'
  }
  return Object.values(connections).some((connection) => connection === true)
    ? 'ONLINE'
    : 'OFFLINE'
}

export function createRealtimePresenceReader({ database } = {}) {
  const db = requireDatabase(database)

  return Object.freeze({
    async getPresenceByFirebaseUid(firebaseUid) {
      const uid = normalizeFirebaseUid(firebaseUid)
      try {
        const snapshot = await db.ref(`presence/${uid}`).once('value')
        const value = snapshot?.val?.() ?? null
        return Object.freeze({
          state: presenceState(value),
          lastOnlineAt: normalizeLastOnlineAt(value?.lastOnlineAt),
        })
      } catch {
        return Object.freeze({ state: 'UNKNOWN', lastOnlineAt: null })
      }
    },
  })
}
