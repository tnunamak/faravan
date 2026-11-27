import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {openDevice} from '../lib/v1/device.mjs';
import {hostV1, ensureV1HostState, provisionLocalCircle} from '../lib/v1/host.mjs';
import {startCoordinator} from '../lib/coordinator.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {randomUUID} from 'node:crypto';

const golden=JSON.parse(await readFile(new URL('../docs/protocol/vectors/golden.json',import.meta.url),'utf8'));

async function fixture(t, {legacy = false} = {}) {
  const root=await mkdtemp(join(tmpdir(),'faravan-multiple-host-'));
  const original=join(root,'fixture-home'),home=join(root,'host'),ownerHome=join(root,'owner');
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin='http://127.0.0.1:'+port;
  const device=await openDevice({home:ownerHome,ensureDefault:false});
  const first=await device.createCircle(origin,{name:'Original circle',publish:false});
  await provisionLocalCircle({home:original,circle:first});
  const {config,paths}=ensureV1HostState({home:original,port,name:first.name});
  await writeFile(paths.config,JSON.stringify({...config,circle_id:first.id,root_fingerprint:first.pinnedRootFingerprint,
    v1_origin:origin,provisioning_path:first.provisioningPath,reachability:{kind:'url',publicUrl:origin}}));
  // This is our own real SQLite home, copied with its durable identity intact.
  await cp(original,home,{recursive:true});
  const configPath=join(home,'host.json');
  const copied=JSON.parse(await readFile(configPath,'utf8'));
  await writeFile(configPath,JSON.stringify({...copied,status_path:join(home,'status.json')}));
  let server,starts=0,stops=0;
  const start=async router=>{
    server=await startCoordinator({port,v1:{origin,dbPath:join(home,'v1','coordinator.sqlite'),blobDir:join(home,'v1','blobs'),
      ...(router?{circlesDir:join(home,'v1','circles')}:{})}});
    starts++;
    await writeFile(join(home,'status.json'),JSON.stringify({protocol_version:1,pid:process.pid,port,status:'listening',public_url:origin,...(router?{circles_router:true}:{})}));
    return {stop:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
  };
  await start(!legacy);
  t.after(async()=>{if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});});
  const seams={portInUse:async()=>server?.listening===true,processExists:()=>true,openDevice:async()=>device,
    // The HTTP server runs inside the test process; model only its separate coordinator identity.
    identityOptions:{platform:'linux',readlink:file=>file.endsWith('/exe')?process.execPath:'pid:[test]',readFile:file=>file.endsWith('/cmdline')?
      ['node',new URL('../bin/faravan-coordinator',import.meta.url).pathname,'--host-config',configPath].join('\0')+'\0':
      file.endsWith('/boot_id')?'test-boot':process.pid+' (node) '+['S',...Array(18).fill('0'),'42'].join(' ')},
    startServer:async()=>start(true),stopServer:async()=>{stops++;server.closeAllConnections();await new Promise(r=>server.close(r));},
    waitReady:async()=>JSON.parse(await readFile(join(home,'status.json'),'utf8'))};
  return {home,ownerHome,origin,first,device,seams,counts:()=>({starts,stops})};
}

for(const legacy of [false,true]) test('another circle on '+(legacy?'a copied legacy host':'the running router')+' preserves the first circle',async t=>{
  const f=await fixture(t,{legacy});
  const firstClient=await f.device.client(f.first.id);
  const signedRoster=await firstClient.refreshRoster();
  const blob=await firstClient.uploadArtifact(Buffer.from('original private bytes'),'text/plain');
  const stamp=n=>new Date(n*1000).toISOString().replace('.000Z','Z'),now=Math.floor(Date.now()/1000);
  const job=await firstClient.submitJob({...structuredClone(golden.objects.job.envelope.payload),circle:f.first.id,author:f.device.keyId,
    roster_epoch:signedRoster.payload.epoch,intent_id:randomUUID(),created_at:stamp(now),expires_at:stamp(now+3600),
    prompt:blob,source:{kind:'archive',artifact:await firstClient.uploadArtifact(Buffer.from('fixture source'),'application/gzip')}});
  const added=await hostV1({home:f.home,name:'Second circle'},f.seams);
  assert.notEqual(added.circle.id,f.first.id);
  assert.equal(added.origin,f.origin);
  assert.deepEqual(f.counts(),legacy?{starts:2,stops:1}:{starts:1,stops:0});
  assert.deepEqual(await firstClient.refreshRoster(),signedRoster,'the exact signed legacy roster survives');
  assert.equal((await firstClient.getJob(job.jobDigest)).state,'queued','existing jobs retain their digest and state');
  assert.equal((await firstClient.fetchArtifact(blob)).toString(),'original private bytes');
  const second=await f.device.client(added.circle.id);
  await assert.rejects(second.fetchArtifact(blob),e=>e.status===404);
  assert.equal((await second.uploadArtifact(Buffer.from('second bytes'),'text/plain')).bytes,12);
  const primary=JSON.parse(await readFile(join(f.home,'host.json'),'utf8'));
  assert.equal(primary.circle_id,f.first.id);assert.equal(primary.v1_origin,f.origin);
  assert.equal(primary.collective_name,'Original circle');
  assert.deepEqual(primary.circle_ids,[f.first.id,added.circle.id]);
  const ownStore=openV1Store({path:join(f.home,'v1','circles',added.circle.id,'coordinator.sqlite')});
  try {assert.equal(ownStore.configuration().circle,added.circle.id);}finally{ownStore.close();}
});
