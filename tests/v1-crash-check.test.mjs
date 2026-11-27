import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crashProcess} from './helpers/crash-process.mjs';

const stateWorker=fileURLToPath(new URL('./helpers/recovery-state-child.mjs',import.meta.url));
test('G12 SIGKILL with an unexpired diagnostic: the reaper forgets the expired lease and never removes compute',async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-check-crash-'));
  await crashProcess(t,stateWorker,[root,'check','create'],'check-created');
  await crashProcess(t,stateWorker,[root,'check','recover'],'check-recovered');
  const orphan=testSandboxName('wf-pull-0000000000000000-01234567');
  const liveId='wf-pull-0000000000000000-89abcdef',live=testSandboxName(liveId);
  const startup=JSON.parse(readFileSync(join(root,'startup.json'),'utf8'));
  assert.ok(startup.now<startup.expiresAt,'the first sweep runs before expiry');
  assert.deepEqual(startup.names.sort(),[orphan,live,'unowned'].sort(),'startup must leave the unexpired diagnostic present');
  const recovered=JSON.parse(readFileSync(join(root,'remaining.json'),'utf8'));
  assert.ok(recovered.now>startup.expiresAt);
  // The sandbox stays with the cleanup record that reserved its name.
  assert.deepEqual(recovered.names.sort(),[orphan,live,'unowned'].sort(),'the check reaper removes no sandbox');
  assert.deepEqual(recovered.journal.map(row=>row.job_id),[liveId],'only the abandoned expired lease is forgotten');
  assert.ok(recovered.journal[0].expires_at<recovered.now,'a live expired diagnostic remains protected');
});
