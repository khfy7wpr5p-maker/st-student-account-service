import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'
const PROJECT_ID='demo-st-student-account'
test('private account-service Firestore collections deny direct browser reads and writes',async()=>{const rules=await fs.readFile(new URL('../../firestore.rules',import.meta.url),'utf8');const env=await initializeTestEnvironment({projectId:PROJECT_ID,firestore:{rules}});try{for(const db of [env.unauthenticatedContext().firestore(),env.authenticatedContext('student-a').firestore(),env.authenticatedContext('teacher-a').firestore()]){for(const path of ['studentInvitations/invite-a','studentAccounts/student-a','teacherStudentRelationships/rel-a','studentUsage/student-a']){await assertFails(getDoc(doc(db,path)));await assertFails(setDoc(doc(db,path),{x:true}))}}}finally{await env.cleanup()}assert.ok(true)})
