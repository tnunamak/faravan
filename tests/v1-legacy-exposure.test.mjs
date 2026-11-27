import './helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {ensureV1HostState,hostV1,stopV1Host} from '../lib/v1/host.mjs';
import {stagedExposure} from './helpers/gozar-fixture.mjs';

test('unverified legacy ownership leaves its exact record, credentials and foreign rules in place',async t=>{
  const home=await mkdtemp(join(userInfo().homedir,'.tmp','fl-'));
  const fixture=await stagedExposure(t,{kind:'durable'});
  t.after(()=>rm(home,{recursive:true,force:true}));
  const {paths,config}=ensureV1HostState({home}),tokenPath=join(home,'old-credential');
  const token='legacy-credential-canary',origin='https://saved.example';
  const reachability={kind:'url',publicUrl:origin,previousOwner:{exactResource:'owned-rule',credentialFile:tokenPath}};
  const old={...config,reachability,v1_origin:origin};
  const ledger=join(fixture.folder,'store.json'),foreign={foreign:true,rule:{forward:'127.0.0.1:6000'}};
  const original=JSON.parse(await readFile(ledger));
  await writeFile(ledger,JSON.stringify({...original,entries:{b:foreign}}));
  await writeFile(tokenPath,token,{mode:0o600});
  await writeFile(paths.config,JSON.stringify(old),{mode:0o600});
  const seams={hostingApi:fixture.gozar,portInUse:async()=>false,openDevice:async()=>({}),
    startServer:()=>assert.fail('must not launch through unverified ownership')};
  await assert.rejects(hostV1({home,tunnel:'public',origin},seams),error=>{
    assert.equal(error.code,'legacy_exposure_pending');
    assert.ok(!JSON.stringify(error).includes(token));
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(paths.config)),old);
  await assert.rejects(stopV1Host({home},seams),{code:'legacy_exposure_pending'});
  assert.deepEqual(JSON.parse(await readFile(paths.config)).reachability,reachability);
  assert.equal(await readFile(tokenPath,'utf8'),token);
  assert.deepEqual(JSON.parse(await readFile(ledger)).entries,{b:foreign});
  assert.equal(fixture.opened.size,0);
});
