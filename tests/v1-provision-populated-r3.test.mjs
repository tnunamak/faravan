import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDevice} from '../lib/v1/device.mjs';
import {provisionLocalCircle} from '../lib/v1/host.mjs';

test('R3 missing configuration in a populated database is corruption rather than permission to provision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'r3-provision-populated-'));
  const device=await openDevice({home:join(root,'device'),ensureDefault:false});
  const circle=await device.createCircle('http://127.0.0.1:8787',{publish:false}),home=join(root,'host'),file=join(home,'v1','coordinator.sqlite');
  await provisionLocalCircle({home,circle});
  const db=new DatabaseSync(file);db.exec("DELETE FROM circle WHERE id='config'");
  const before=db.prepare('SELECT data FROM rosters ORDER BY id').all();db.close();
  await assert.rejects(provisionLocalCircle({home,circle}));
  const after=new DatabaseSync(file);assert.deepEqual(after.prepare('SELECT data FROM rosters ORDER BY id').all(),before);after.close();
});
