export function assertPresenceReader(reader) {
  if (!reader || typeof reader !== 'object' || typeof reader.getPresenceByFirebaseUid !== 'function') {
    throw new TypeError('presence reader must provide getPresenceByFirebaseUid().')
  }
  return reader
}
