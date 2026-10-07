import { revokeStudentInvitation } from '../domain/studentInvitation.js'
import { normalizeRequiredId } from '../domain/validation.js'
import { assertInvitationRepository } from '../ports/invitationRepository.js'
import { assertClock } from '../ports/clock.js'
export function revokeInvitationService({repository,clock}={}){const repo=assertInvitationRepository(repository);const trustedClock=assertClock(clock);return Object.freeze({async execute({teacherId,inviteId}={}){const t=normalizeRequiredId(teacherId,'teacherId');const id=normalizeRequiredId(inviteId,'inviteId');const row=await repo.getById(id);if(!row)throw new Error('invitation not found');if(row.teacherId!==t)throw new Error('forbidden: invitation owner mismatch');if(row.status!=='PENDING')throw new Error('StudentInvitation must be PENDING for revoke');return repo.replace(row,revokeStudentInvitation(row,trustedClock.now()))}})}
