import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

const stateWorker=fileURLToPath(new URL('./helpers/recovery-state-child.mjs',import.meta.url));
test('G11 SIGKILL after schema creation resumes the same provisioning',async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-provision-crash-'));
  await crashProcess(t,stateWorker,[root,'provision','create'],'schema-created');
  await crashProcess(t,stateWorker,[root,'provision','recover'],'provisioned');
  assert.equal(readFileSync(join(root,'provisioned'),'utf8'),'ok');
});
