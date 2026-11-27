import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

test('G09 SIGKILL recovery compares macOS process identity instead of trusting a reused PID',async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-lock-crash-'));
  const script=fileURLToPath(new URL('./helpers/recovery-lock-child.mjs',import.meta.url));
  await crashProcess(t,script,[root,'create'],'lock-published');
  await crashProcess(t,script,[root,'recover'],'lock-recovered');
  assert.equal(readFileSync(join(root,'lock-recovered'),'utf8'),'ok');
});
