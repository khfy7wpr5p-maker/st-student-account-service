import { pathToFileURL } from 'node:url'

import { createStudentAccountService } from './composition.js'

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parsePort(value) {
  if (value === undefined || value === null || value === '') return 3000
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new TypeError('PORT must be an integer between 1 and 65535.')
  }
  return parsed
}

export function configFromEnvironment(env = process.env) {
  return Object.freeze({
    mode: optionalText(env.ACCOUNT_SERVICE_MODE) ?? optionalText(env.NODE_ENV) ?? 'development',
    projectId: optionalText(env.FIREBASE_PROJECT_ID),
    databaseURL: optionalText(env.FIREBASE_DATABASE_URL),
    invitationBaseUrl: optionalText(env.STUDENT_INVITATION_BASE_URL),
    firebaseAppName: optionalText(env.FIREBASE_APP_NAME),
  })
}

export function startStudentAccountServer({ env = process.env, adapters } = {}) {
  const service = createStudentAccountService({
    config: configFromEnvironment(env),
    adapters,
  })
  const port = parsePort(env.PORT)
  const host = optionalText(env.HOST) ?? '0.0.0.0'
  const server = service.app.listen(port, host)
  let closePromise = null

  return Object.freeze({
    server,
    close() {
      if (closePromise) return closePromise
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }).then(() => service.close?.())
      return closePromise
    },
  })
}

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
)

if (isDirectExecution) {
  try {
    const runtime = startStudentAccountServer()
    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      try {
        await runtime.close()
      } catch {
        process.exitCode = 1
      }
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch {
    console.error(JSON.stringify({ event: 'startup_failed', outcome: 'CONFIGURATION_ERROR' }))
    process.exitCode = 1
  }
}
