const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function assertStrictInputObject(input, allowedFields, label = 'input') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const allowed = new Set(allowedFields)
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unsupported field: ${key}`)
  }
}

export function normalizeRequiredId(value, fieldName) {
  if (typeof value !== 'string') throw new TypeError(`${fieldName} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || CONTROL_CHARS.test(normalized)) {
    throw new TypeError(`${fieldName} must be a bounded non-empty id.`)
  }
  return normalized
}

export function normalizeRequiredText(value, fieldName, maxLength = 200) {
  if (typeof value !== 'string') throw new TypeError(`${fieldName} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || CONTROL_CHARS.test(normalized)) {
    throw new TypeError(`${fieldName} must be bounded non-empty text.`)
  }
  return normalized
}

export function normalizeEmail(value, fieldName = 'email') {
  const normalized = normalizeRequiredText(value, fieldName, 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new TypeError(`${fieldName} must be a valid email address.`)
  }
  return normalized
}

export function normalizeTimestamp(value, fieldName) {
  if (typeof value !== 'string') throw new TypeError(`${fieldName} must be an ISO timestamp.`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError(`${fieldName} must be an ISO timestamp.`)
  return date.toISOString()
}

export function normalizeNullableTimestamp(value, fieldName) {
  return value === null ? null : normalizeTimestamp(value, fieldName)
}

export function addDays(timestamp, days) {
  const date = new Date(normalizeTimestamp(timestamp, 'timestamp'))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

export function requireBoolean(value, fieldName) {
  if (typeof value !== 'boolean') throw new TypeError(`${fieldName} must be a boolean.`)
  return value
}

export function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer.`)
  }
  return value
}

export function normalizeSha256(value, fieldName = 'tokenHash') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError(`${fieldName} must be a SHA-256 hex digest.`)
  }
  return value.toLowerCase()
}
