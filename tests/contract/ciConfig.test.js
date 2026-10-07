import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

test('CI requires no npm lockfile cache and no production Firebase identity',async()=>{const text=await fs.readFile(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');assert.equal(/cache:\s*npm/.test(text),false);assert.equal(/service.?account|private.?key/i.test(text),false);assert.equal(/demo-st-student-account/.test(text),false);assert.match(text,/native\/student-account-service-v1/);assert.match(text,/actions\/setup-java@v4/);assert.match(text,/java-version:\s*['\"]?21/)})

test('RTDB presence rules reject unknown fields under a student presence node',async()=>{const rules=JSON.parse(await fs.readFile(new URL('../../database.rules.json',import.meta.url),'utf8'));assert.equal(rules.rules.presence.$uid.$other['.validate'],false)})
