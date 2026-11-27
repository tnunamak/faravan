import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crashProcess} from './helpers/crash-process.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-app-child.mjs',import.meta.url));
for(const stamped of [true,false])test(`app restart while off recovers without adapters according to prepare provenance: stamp=${stamped}`,{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-app-crash-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const scenario=stamped?'lender':'legacy';
  await crashProcess(t,worker,[root,'create',scenario],'journal-saved');
  await crashProcess(t,worker,[root,'recover',scenario],'app-recovered');
  const result=JSON.parse(readFileSync(join(root,'observed.json'),'utf8'));
  if(stamped)assert.equal(result.pending,null);
  else {
    assert.equal(result.pending.attemptId,'crashed');
    assert.equal(result.pending.prepare_contract,undefined);
  }
  assert.equal(result.jobs,stamped?0:1);
  assert.equal(result.milliseconds,stamped?0:1000);
  assert.equal(result.intent,'off');
  assert.equal(result.claims,0);
});
