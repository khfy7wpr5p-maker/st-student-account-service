import assert from 'node:assert/strict'
import test from 'node:test'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createFirestoreUsageRepository } from '../../src/adapters/firebase/firestoreUsageRepository.js'
const PROJECT_ID='demo-st-student-account'
test('Firestore usage repository increments each client session id at most once',async()=>{const app=initializeApp({projectId:PROJECT_ID},`usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);const db=getFirestore(app);const repo=createFirestoreUsageRepository({db});try{const input={studentId:'student-a',clientSessionId:'session-a',startedAt:'2026-10-07T18:00:00.000Z',expiresAt:'2026-11-06T18:00:00.000Z'};const [a,b]=await Promise.all([repo.recordSessionOnce(input),repo.recordSessionOnce(input)]);assert.deepEqual([a.totalSessions,b.totalSessions].sort(),[1,1]);assert.equal((await repo.getSummary('student-a')).totalSessions,1);const second=await repo.recordSessionOnce({...input,clientSessionId:'session-b',startedAt:'2026-10-07T18:01:00.000Z',expiresAt:'2026-11-06T18:01:00.000Z'});assert.equal(second.totalSessions,2)}finally{try{await db.recursiveDelete(db.collection('studentUsage'))}catch{}await deleteApp(app)}})
