import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDevice} from '../lib/v1/device.mjs';
import {provisionLocalCircle} from '../lib/v1/host.mjs';
import {openV1Store} from '../lib/v1/store.mjs';

async function fixture(clock){
  const root=await mkdtemp(join(tmpdir(),'r3-provision-'));
  const device=await openDevice({home:join(root,'device'),ensureDefault:false,...(clock?{clock}:{})});
  const circle=await device.createCircle('http://127.0.0.1:8787',{publish:false,name:'Original'});
  return {root,device,circle,home:join(root,'host'),db:join(root,'host','v1','coordinator.sqlite')};
}
test('R3 first provisioning rejects a swapped circle document before creating the database',async()=>{
  const f=await fixture(),other=await f.device.createCircle('http://127.0.0.1:8787',{publish:false,name:'Other',reuse:false});
  await writeFile(f.circle.provisioningPath,await readFile(other.provisioningPath));
  await assert.rejects(provisionLocalCircle(f),/identity does not match/);
  assert.equal(existsSync(f.db),false);
});
test('R3 uninitialized replay rejects mismatched document metadata before committing',async()=>{
  const f=await fixture(),document=JSON.parse(await readFile(f.circle.provisioningPath,'utf8'));
  document.root_fingerprint='wrong-root';await writeFile(f.circle.provisioningPath,JSON.stringify(document));
  await mkdir(join(f.home,'v1'),{recursive:true});await writeFile(f.db,'');
  await assert.rejects(provisionLocalCircle(f),/identity does not match/);
  const db=new DatabaseSync(f.db);assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get().n,0);db.close();
});
