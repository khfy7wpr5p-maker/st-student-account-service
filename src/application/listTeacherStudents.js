import { normalizeRequiredId } from '../domain/validation.js'
import { assertPresenceReader } from '../ports/presenceReader.js'

const UNKNOWN_PRESENCE = Object.freeze({ state: 'UNKNOWN', lastOnlineAt: null })
const MAX_PARALLEL_ROWS = 16

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must provide ${method}().`)
  }
  return value
}

function compareInvitations(left, right) {
  const leftCreated = typeof left?.createdAt === 'string' ? left.createdAt : ''
  const rightCreated = typeof right?.createdAt === 'string' ? right.createdAt : ''
  const byCreated = leftCreated.localeCompare(rightCreated)
  if (byCreated !== 0) return byCreated
  return String(left?.inviteId ?? '').localeCompare(String(right?.inviteId ?? ''))
}

function stateFor({ invitation, relationship, account }) {
  if (relationship?.deactivatedAt) return 'INACTIVE'
  if (invitation.status === 'REVOKED' || invitation.status === 'EXPIRED') return 'INACTIVE'
  if (
    invitation.status === 'ACCEPTED' &&
    relationship?.active === true &&
    account?.active === true
  ) {
    return 'ACTIVE'
  }
  if (invitation.status === 'ACCEPTED' || relationship) return 'ACTIVATING'
  return 'INVITED'
}

function safeUsage(summary, studentId) {
  if (!summary) return { totalSessions: 0, lastSessionAt: null }
  if (summary.studentId !== studentId) throw new Error('student-management-conflict')
  if (!Number.isInteger(summary.totalSessions) || summary.totalSessions < 0) {
    throw new Error('student-management-conflict')
  }
  return {
    totalSessions: summary.totalSessions,
    lastSessionAt: typeof summary.lastSessionAt === 'string' ? summary.lastSessionAt : null,
  }
}

function safePresenceResult(result) {
  if (!result || !['ONLINE', 'OFFLINE', 'UNKNOWN'].includes(result.state)) return UNKNOWN_PRESENCE
  return {
    state: result.state,
    lastOnlineAt: typeof result.lastOnlineAt === 'string' ? result.lastOnlineAt : null,
  }
}

async function mapBounded(items, mapper) {
  const output = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      output[index] = await mapper(items[index])
    }
  }
  const workerCount = Math.min(MAX_PARALLEL_ROWS, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return output
}

export function listTeacherStudentsService({
  invitationRepository,
  studentAccountRepository,
  relationshipRepository,
  usageRepository,
  presenceReader,
} = {}) {
  const invitations = requireMethod(invitationRepository, 'listByTeacherId', 'invitationRepository')
  const accounts = requireMethod(studentAccountRepository, 'getByStudentId', 'studentAccountRepository')
  const relationships = requireMethod(relationshipRepository, 'getBySourceInviteId', 'relationshipRepository')
  const usage = requireMethod(usageRepository, 'getSummary', 'usageRepository')
  const presence = assertPresenceReader(presenceReader)

  return Object.freeze({
    async execute({ teacherId } = {}) {
      const stableTeacherId = normalizeRequiredId(teacherId, 'teacherId')
      const listed = await invitations.listByTeacherId(stableTeacherId)
      if (!Array.isArray(listed)) throw new Error('student-management-conflict')

      const scoped = listed
        .filter((item) => item?.teacherId === stableTeacherId)
        .slice()
        .sort(compareInvitations)

      return mapBounded(scoped, async (invitation) => {
        if (typeof invitation?.inviteId !== 'string' || invitation.inviteId.length === 0) {
          throw new Error('student-management-conflict')
        }

        const relationship = await relationships.getBySourceInviteId(invitation.inviteId)
        if (relationship && relationship.teacherId !== stableTeacherId) {
          throw new Error('student-management-conflict')
        }

        const relationshipStudentId = relationship?.studentId ?? null
        const invitationStudentId = invitation.studentId ?? null
        if (relationshipStudentId && invitationStudentId && relationshipStudentId !== invitationStudentId) {
          throw new Error('student-management-conflict')
        }
        const studentId = relationshipStudentId ?? invitationStudentId
        const account = studentId ? await accounts.getByStudentId(studentId) : null
        if (account && account.studentId !== studentId) throw new Error('student-management-conflict')

        const state = stateFor({ invitation, relationship, account })
        const usagePromise = studentId ? usage.getSummary(studentId) : Promise.resolve(null)
        const presencePromise = state === 'ACTIVE' && account?.firebaseUid
          ? Promise.resolve(presence.getPresenceByFirebaseUid(account.firebaseUid))
              .then(safePresenceResult)
              .catch(() => UNKNOWN_PRESENCE)
          : Promise.resolve(UNKNOWN_PRESENCE)
        const [usageSummary, presenceSummary] = await Promise.all([usagePromise, presencePromise])
        const boundedUsage = safeUsage(usageSummary, studentId)

        return Object.freeze({
          managementId: invitation.inviteId,
          studentId: studentId ?? null,
          displayNameOrNickname: relationship?.displayNameOrNickname ?? invitation.studentDisplayNameOrNickname,
          state,
          invitationStatus: invitation.status ?? null,
          presenceState: presenceSummary.state,
          lastOnlineAt: presenceSummary.lastOnlineAt,
          lastSessionAt: boundedUsage.lastSessionAt,
          totalSessions: boundedUsage.totalSessions,
        })
      })
    },
  })
}
