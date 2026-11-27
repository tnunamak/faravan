import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createSandboxDeadlineManager} from '../lib/sandbox-deadline.mjs';

test('background status pruning removes only orphan statuses with a proven dead publisher',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-prune-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const files=[];
  for(let i=0;i<5;i++){
    const row=path.join(directory,randomUUID()+'.json'),status=row+'.deadline';files.push(status);
    fs.writeFileSync(status,JSON.stringify({pid:100+i,start:'fixture',state:'removed'}));
    if(i===3)fs.writeFileSync(row,'{}');
    if(i===4)fs.symlinkSync(path.join(directory,'missing-row.json'),row);
  }
  const manager=createSandboxDeadlineManager({directory,binary:'/fake/sbx',processStart:async pid=>pid===100||pid===104?null:pid===101?'fixture':undefined});
  await manager.pruneStatuses();
  assert.equal(fs.existsSync(files[0]),false);
  for(const file of files.slice(1))assert.ok(fs.existsSync(file),'live, unknown, current and symlink-row statuses stay');
});
