export function createFakeSecureDeliveryAuthorityPort({ handler, failuresRemaining = 0 } = {}) {
  const calls = []
  const completed = new Map()
  const inFlight = new Map()
  let failures = failuresRemaining

  async function activateStudent(input) {
    const key = JSON.stringify([
      input.firebaseUid,
      input.teacherId,
      input.studentId,
      input.sourceInviteId,
    ])
    if (completed.has(key)) return completed.get(key)
    if (inFlight.has(key)) return inFlight.get(key)

    const operation = (async () => {
      calls.push(Object.freeze({ ...input }))
      if (failures > 0) {
        failures -= 1
        throw new Error('secure-delivery-authority-failure')
      }
      const result = handler
        ? await handler(input)
        : Object.freeze({
            studentId: input.studentId,
            teacherId: input.teacherId,
            identityActive: true,
            grantActive: true,
          })
      completed.set(key, result)
      return result
    })()
    inFlight.set(key, operation)
    try {
      return await operation
    } finally {
      inFlight.delete(key)
    }
  }

  return Object.freeze({ activateStudent, calls })
}
