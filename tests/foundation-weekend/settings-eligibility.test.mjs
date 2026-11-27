// Conservative assumption: unsupported future eligibility fields in the legacy cap store
// must remain unreadable and byte-preserved, not become implicit consent.
// This is NOT timezone evaluation, journal-lock serialization or quote invalidation coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createOwnerSettings} from '../../lib/v1/owner-settings.mjs';

for(const [label,extra] of [
  ['explicit Ask',{mode:'ask'}],
  ['explicit Off',{intent:'off'}],
  ['timed pause',{intent:'on',pause_until:2000}],
  ['timezone schedule',{timeZone:'America/New_York',schedule:[{start:'22:00',end:'06:00'}]}],
  ['future strategy',{strategy:'future-strategy'}],
]) {
  test('conservative legacy assumption: preserve unsupported '+label+' without migrating or granting',async()=>{
    const directory=await mkdtemp(join(process.cwd(),'.settings-eligibility-'));
    const path=join(directory,'owner-settings.json');
    try {
      const bytes=JSON.stringify({version:1,values:{maxJobUsd:4,weeklyOverrunPoints:0.1,...extra},audit:[]},null,2)+'\n';
      await writeFile(path,bytes,{mode:0o600});
      for(const now of [1000,3000]) {
        const store=createOwnerSettings({directory,now:()=>now});
        assert.deepEqual(store.limit(),{state:'unreadable',maxJobUsd:null});
        assert.equal(store.values(),null);
        assert.throws(()=>store.set({by:'synthetic-owner',reason:'cap only',now,maxJobUsd:5}),
          /unreadable_owner_settings/);
        assert.equal(await readFile(path,'utf8'),bytes);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
}
test('conservative legacy reader: re-read a torn replacement rather than cached permission',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.settings-eligibility-'));
  const path=join(directory,'owner-settings.json');
  try{
    const store=createOwnerSettings({directory});
    store.set({by:'synthetic-owner',reason:'initial cap',now:1000,maxJobUsd:4});
    assert.equal(store.limit().state,'set');
    const torn='{"version":1,"values":';
    await writeFile(path,torn,{mode:0o600});
    assert.equal(store.limit().state,'unreadable');
    assert.throws(()=>store.set({by:'synthetic-owner',reason:'do not erase',now:2000,maxJobUsd:6}),
      /unreadable_owner_settings/);
    assert.equal(await readFile(path,'utf8'),torn);
    await writeFile(path,JSON.stringify({version:1,values:{maxJobUsd:3},audit:[]}),{mode:0o600});
    assert.deepEqual(store.limit(),{state:'set',maxJobUsd:3});
    assert.deepEqual(createOwnerSettings({directory}).limit(),store.limit());
  }finally{await rm(directory,{recursive:true,force:true});}
});
