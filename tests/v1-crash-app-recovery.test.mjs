import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crashProcess} from './helpers/crash-process.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-app-child.mjs',import.meta.url));
test('G06 app restart drains saved submit and cancel intents without another invocation',{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-outbox-crash-'));
  await crashProcess(t,worker,[root,'create','outbox'],'journal-saved');
  await crashProcess(t,worker,[root,'recover','outbox'],'app-recovered');
  const result=JSON.parse(readFileSync(join(root,'observed.json'),'utf8'));
  assert.equal(result.submits,1);assert.equal(result.cancels,1);
});
