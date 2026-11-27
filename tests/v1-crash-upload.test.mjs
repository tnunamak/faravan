import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

test('G10 SIGKILL between blob install and DB commit releases orphan quota on restart',async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-upload-crash-'));
  const uploadWorker=fileURLToPath(new URL('./helpers/recovery-upload-child.mjs',import.meta.url));
  await crashProcess(t,uploadWorker,[root,'create'],'blob-installed');
  await crashProcess(t,uploadWorker,[root,'recover'],'upload-recovered');
  const recovered=JSON.parse(readFileSync(join(root,'recovered-upload.json'),'utf8'));
  assert.equal(recovered.reservations,0);
  assert.equal(recovered.quota.uploads,0);assert.equal(recovered.quota.reserved_bytes,0);
  assert.deepEqual(recovered.blobs,[]);
});
