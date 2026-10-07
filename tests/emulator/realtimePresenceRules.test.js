import fs from 'node:fs/promises'
import test from 'node:test'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { ref, set, get } from 'firebase/database'
const PROJECT_ID='demo-st-student-account'
test('RTDB presence rules allow only own writes and deny broad reads',async()=>{const rules=await fs.readFile(new URL('../../database.rules.json',import.meta.url),'utf8');const env=await initializeTestEnvironment({projectId:PROJECT_ID,database:{rules}});try{const own=env.authenticatedContext('uid-a').database();const other=env.authenticatedContext('uid-b').database();await assertSucceeds(set(ref(own,'presence/uid-a/connections/c1'),true));await assertSucceeds(set(ref(own,'presence/uid-a/lastOnlineAt'),Date.now()));await assertFails(set(ref(own,'presence/uid-a/unexpected'),true));await assertFails(set(ref(other,'presence/uid-a/connections/c2'),true));await assertFails(get(ref(own,'presence')));await assertFails(get(ref(own,'presence/uid-a')))}finally{await env.cleanup()}})
