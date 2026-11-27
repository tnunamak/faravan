import './helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {gozarFixture,listen,stop,send} from './helpers/gozar-fixture.mjs';
import {startChatgptGateway} from '../lib/v1/chatgpt-mcp.mjs';

const withCost = cost => ({extend:async folder=>{
  const file = join(folder,'definition.json');
  const definition = JSON.parse(await readFile(file,'utf8'));
  definition.adapter.capabilities.cost = cost;
  await writeFile(file,JSON.stringify(definition));
}});

test('public review resolves the pinned loopback target without writing host state', async t => {
  const {tmpdir} = await import('node:os');
  const {resolveHostReviewTarget} = await import('../lib/v1/host.mjs');
  const root = await mkdtemp(join(tmpdir(), 'host-review-target-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const home = join(root, 'coordinator');
  assert.deepEqual(resolveHostReviewTarget({home}), {home, port:8787, target:'127.0.0.1:8787'});
  assert.deepEqual(resolveHostReviewTarget({home,port:12345}), {home, port:12345, target:'127.0.0.1:12345'});
  assert.throws(() => resolveHostReviewTarget({home,port:12345.5}), /--port/);
  await assert.rejects(readFile(join(home,'host.json')), {code:'ENOENT'});
  await assert.rejects(readFile(join(home,'exposure.json')), {code:'ENOENT'});
  await mkdir(home);
  const origin = 'https://original.example.invalid';
  const host = JSON.stringify({schema_version:1,protocol_version:1,port:23456,reachability:{kind:'gozar'},
    circle_id:'synthetic-circle',v1_origin:origin});
  const saved = JSON.stringify({spec:{reach:'internet',address:'stable',target:'127.0.0.1:23456',origin}});
  await writeFile(join(home,'host.json'), host);
  await writeFile(join(home,'exposure.json'), saved);
  assert.deepEqual(resolveHostReviewTarget({home}), {home, port:23456, target:'127.0.0.1:23456', origin});
  assert.throws(() => resolveHostReviewTarget({home,port:23457}), {code:'operation_conflict'});
  assert.equal(await readFile(join(home,'host.json'),'utf8'), host);
  assert.equal(await readFile(join(home,'exposure.json'),'utf8'), saved);
  await writeFile(join(home,'exposure.json'), saved.replace('127.0.0.1:23456','127.0.0.1:23457'));
  assert.throws(() => resolveHostReviewTarget({home}), {code:'operation_conflict'});
});

test('public host offer review binds both queries and projects only owner facts', async t => {
  const {tmpdir} = await import('node:os');
  const {reviewPublicHostOffers} = await import('../lib/v1/host.mjs');
  const home = await mkdtemp(join(tmpdir(),'host-offer-review-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const port=24567, target='127.0.0.1:'+port, origin='https://saved.example.invalid';
  const config=JSON.stringify({schema_version:1,protocol_version:1,port,v1_origin:origin,
    circle_id:'fixture-circle',reachability:{kind:'gozar'}});
  await writeFile(join(home,'host.json'),config);
  const cost={kind:'paid',summary:'No charge in fixture',amount:0,currency:'USD',period:'month'};
  const traffic={tlsTermination:'endpoint',providerCanReadPayload:null,readers:['owner'],metadataVisibleTo:['operator']};
  const address={scope:'public',stability:'stable',conditions:['fixed hostname'],ports:null};
  const protocols={sse:false,streamableHttp:true,oauthDcr:false};
  const disclosure={revision:'example-v1',text:'Fixture terms',links:[
    {rel:'terms',label:'Terms',href:'https://terms.example.invalid/'},
    {rel:'privacy',label:'Privacy',href:'https://privacy.example.invalid/'},
  ]};
  const facts={reach:'internet',transport:'https',traffic,address,ownership:'gozar-owned',cost,
    lifetimes:['attached','durable'],supervision:'controller',protocols,disclosure};
  const display={label:'Fixture',description:'Public address',needs:'Nothing'};
  const requests=[];
  let ready=true, wrongBinding=false;
  const hostingApi=new Proxy({async catalogRoutes(query){
    requests.push(query);
    const usage=query.usage.kind, providerId='fixture-'+usage, digest='synthetic-digest-'+usage;
    return {candidates:[
      {eligible:false},
      {eligible:true,providerId,display:{...display,unexpected:'exclude-display'},
        configuration:{actorId:'exclude-config'},setup:{state:ready?'ready':'action-required',secret:'exclude-setup'},
        candidateToken:'exclude-candidate',consentFactsDigest:digest,disclosure:{revision:'example-v1'},
        consent:{consentFactsDigest:digest,scope:{kind:'route',providerId,privateId:'exclude-scope',
          query:{usage:query.usage,reach:'internet',transport:'https',target:wrongBinding?'127.0.0.1:1':target,expectedOrigin:origin}},
          disclosures:{...facts,traffic:{...traffic,evidenceRef:'exclude-evidence',raw:'exclude-traffic'},
            address:{...address,hidden:'exclude-address'},cost:{...cost,accountId:'exclude-cost'},
            protocols:{...protocols,extra:'exclude-protocol'},
            disclosure:{...disclosure,links:disclosure.links.map(link=>({...link,extra:'exclude-link'}))}}}}
    ]};
  }},{get(ref,key){assert.equal(key,'catalogRoutes','review calls only the catalog');return ref[key];}});
  assert.deepEqual(await reviewPublicHostOffers({home},{hostingApi}),{
    status:'ready',port,offers:['attached','durable'].map(usage=>({
      providerId:'fixture-'+usage,usage,consentFactsDigest:'synthetic-digest-'+usage,display,disclosures:facts,
    })),
  });
  assert.deepEqual(requests,['attached','durable'].map(kind=>({schemaVersion:1,home:join(home,'gz'),
    owner:'faravan-coordinator',target,origin,usage:kind==='durable'?{kind,routeId:'faravan-coordinator'}:{kind},
    requirements:{reach:'internet',address:'stable',transport:'https',payloadAccess:'allow-provider',setup:'allow',protocols:[]},
  })));
  const saved = JSON.stringify({spec:{target,reach:'internet',address:'stable',origin,
    providerId:'fixture-durable',usage:'durable'}});
  await writeFile(join(home,'exposure.json'),saved);
  const retained = await reviewPublicHostOffers({home},{hostingApi});
  assert.deepEqual(retained.offers.map(row=>[row.providerId,row.usage]),[['fixture-durable','durable']]);
  assert.deepEqual(requests.slice(2).map(query=>[query.providerId,query.usage.kind]),[['fixture-durable','durable']]);
  assert.equal(await readFile(join(home,'exposure.json'),'utf8'),saved);
  await rm(join(home,'exposure.json'));

  wrongBinding=true;
  assert.deepEqual(await reviewPublicHostOffers({home},{hostingApi}),{status:'unavailable',port,offers:[],
    nextAction:'Complete public route setup, then review the offers again.'});
  wrongBinding=false; ready=false;
  assert.equal((await reviewPublicHostOffers({home},{hostingApi})).status,'unavailable');
  assert.equal(await readFile(join(home,'host.json'),'utf8'),config);
  await assert.rejects(readFile(join(home,'exposure.json')),{code:'ENOENT'});
});

test('installed public Host catalog leaves selection and consent unchanged', {timeout:30000}, async t=>{
  const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
  const {ensureV1HostState,reviewPublicHostOffers}=await import('../lib/v1/host.mjs');
  const {coordinatorHosting}=await import('../lib/coordinator-hosting.mjs');
  const fixture=await stagedExposure(t,{kind:'durable',reach:'internet'});
  const home=await mkdtemp(join(userInfo().homedir,'.tmp','fr-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const port=24680,target='127.0.0.1:'+port;
  const hostFile=join(home,'host.json'),stateFile=join(home,'exposure.json');
  const providerFile=join(fixture.folder,'store.json');
  const providerBefore=await readFile(providerFile);
  const calls=[];
  const reviewingSdk=new Proxy(fixture.gozar,{get(sdk,key){
    if(key==='catalogRoutes') return query=>{
      calls.push({usage:query.usage.kind,providerId:query.providerId});
      return sdk.catalogRoutes(query);
    };
    return ()=>assert.fail('Host review must not dispatch '+String(key));
  }});
  const review=()=>reviewPublicHostOffers({home,port},{hostingApi:reviewingSdk});
  const first=await review();
  assert.equal(first.status,'ready');
  assert.ok(first.offers.some(offer=>offer.providerId===fixture.id));
  assert.deepEqual(calls,[{usage:'attached',providerId:undefined},{usage:'durable',providerId:undefined}]);
  assert.ok((await stat(join(home,'gz'))).isDirectory(),'SDK catalog state is allowed');
  await assert.rejects(readFile(hostFile),{code:'ENOENT'});
  await assert.rejects(readFile(stateFile),{code:'ENOENT'});

  // Seed selection and pending consent through their real operations, not by
  // asking the review to write a selection or handle.
  ensureV1HostState({home,port});
  const exposure=coordinatorHosting(home,fixture.gozar);
  const spec={target,reach:'internet',address:'stable',usage:'durable'};
  const [offer]=await exposure.offers(spec);
  assert.ok(offer?.approval);
  assert.equal(offer.providerId,fixture.id);
  await exposure.select(spec,offer);
  await exposure.authorize(offer.consent.consentFactsDigest,{binding:'fixture-review'});
  const selected=exposure.read();
  assert.ok(selected.pendingApproval);
  const [hostBefore,exposureBefore]=await Promise.all([readFile(hostFile),readFile(stateFile)]);
  await review();
  assert.deepEqual(calls,[{usage:'attached',providerId:undefined},{usage:'durable',providerId:undefined},
    {usage:'durable',providerId:offer.providerId}]);
  assert.deepEqual(await readFile(hostFile),hostBefore);
  assert.deepEqual(await readFile(stateFile),exposureBefore);
  assert.deepEqual(exposure.read(),selected);
  assert.deepEqual(await readFile(providerFile),providerBefore);
  assert.equal(fixture.opened.size,0);
  assert.deepEqual(fixture.proofTargets,[]);
});

test('installed Gozar gates the real MCP listener, fences retries, and removes only the owned forwarder', async t => {
  const {createHosting} = await import('../lib/coordinator-hosting.mjs');
  const base = join(userInfo().homedir, '.tmp');
  await mkdir(base, {recursive:true});
  const directory = await mkdtemp(join(base, 'fh-'));
  const fixture = await gozarFixture(directory);
  const {id,opened,proofTargets} = fixture;
  const app = await startChatgptGateway({home:directory, localOrigin:()=> 'http://127.0.0.1:1'});
  const sentinel = createServer((req,res) => res.end('foreign'));
  await listen(sentinel);
  let hosting;
  try {
    const target = '127.0.0.1:' + app.port;
    const options = {directory, owner:'faravan-test', api:fixture.gozar};
    hosting = createHosting(options);
    const query = {target, reach:'internet', address:'any', protocols:['streamable-http','oauth-dcr'], usage:'attached'};
    const [offer] = await hosting.offers(query);
    assert.equal(offer.providerId, id);
    const free = {kind:'free',summary:'A fake costs nothing.'};
    assert.deepEqual(offer.properties.cost,free);
    assert.deepEqual(offer.consent.disclosures.cost,free);
    await hosting.select(query, offer);
    await assert.rejects(hosting.start(), {code:'consent_required'});
    assert.equal(opened.size, 0);
    const route = await hosting.start(offer.approval);
    assert.equal(route.verification.status, 'verified');
    assert.ok(proofTargets.length > 0);
    const [owned] = opened.values();
    assert.notEqual(owned.target, target, 'Provider traffic goes through the Gozar-owned gate');
    const exposed = '127.0.0.1:' + owned.server.address().port;
    app.configure(route.published);
    const denied = await send(exposed, {path:'/mcp',headers:{'x-forwarded-for':'203.0.113.24'}});
    assert.equal(denied.status, 401);
    assert.deepEqual(JSON.parse(denied.bytes), {error:'invalid_token'});
    assert.equal((await send(exposed, {path:'/api/handoff'})).status, 404);
    const metadata = await send(exposed, {path:'/.well-known/oauth-protected-resource/mcp'});
    assert.equal(JSON.parse(metadata.bytes).resource, route.published + '/mcp');

    hosting = createHosting(options);
    assert.deepEqual((await hosting.start(offer.approval)).handle, route.handle);
    await assert.rejects(hosting.select({...query,target:'127.0.0.1:'+sentinel.address().port},offer), {code:'operation_conflict'});
    assert.equal(opened.size, 1);
    assert.equal((await hosting.close()).cleanup.state, 'confirmed');
    await assert.rejects(send(exposed, {path:'/mcp'}));
    assert.equal((await send('127.0.0.1:' + sentinel.address().port, {path:'/'})).bytes.toString(), 'foreign');
    assert.equal((await send(target, {path:'/mcp'})).status, 401);
  } finally {
    try {
      await hosting?.close().catch(() => {});
      await fixture.close();
    } finally {
      await Promise.all([app.close(),stop(sentinel)]);
      await rm(directory,{recursive:true,force:true});
    }
  }
});

test('actual App endpoint and connect command require approval and keep local authority separate', {timeout:45000}, async t => {
  const {stagedExposure,shortGozarAppHome} = await import('./helpers/gozar-fixture.mjs');
  const paid = {kind:'paid',summary:'Zero-price paid fixture',amount:0,currency:'USD',period:'month'};
  const fixture = await stagedExposure(t,withCost(paid));
  const {appFixture,api} = await import('./helpers/v1-app-fixture.mjs');
  const f = await appFixture(t);
  const {connectChatgpt} = await import('../lib/v1/connect-chatgpt.mjs');
  await shortGozarAppHome(t,f,'g');
  const {app,home} = await f.start('g',{chatgptGozar:fixture.gozar});
  const client = {rest:(method,path,{body}={})=>api(app,path,{method,body})};
  const before = await client.rest('POST','/api/chatgpt/start',{body:{}});
  assert.equal(before.status, 'approval_required');
  await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
  assert.equal(fixture.opened.size,0);
  let approvals = 0;
  const interaction={choose:async offers=>{
      assert.equal(offers[0].providerId,fixture.id);
      assert.deepEqual(offers[0].properties.cost,paid);
      return offers[0];
    },
    driveSetup:async (controller,operation)=>operation,
    approve:async snapshot=>{
      assert.equal(snapshot.scope.kind,'route');
      assert.deepEqual(snapshot.disclosures.cost,paid);
      approvals++;
      return true;
    }};
  const live = await connectChatgpt({home},{client,gozar:fixture.gozar,interaction});
  assert.equal(fixture.opened.size,1);
  assert.equal(approvals,1);
  assert.match(live.url,/^https:\/\/.*\.invalid\/mcp$/);
  const [owned] = fixture.opened.values(), address = '127.0.0.1:'+owned.server.address().port;
  assert.equal((await send(address,{path:'/mcp'})).status,401);
  assert.equal((await send(address,{path:'/api/chatgpt/start',method:'POST'})).status,404);
  assert.equal((await send(address,{path:'/auth/handoff'})).status,404);
  assert.equal((await api(app,'/api/chatgpt/status')).url,live.url);
  fixture.failClose(true);
  const failed=await client.rest('POST','/api/chatgpt/disconnect',{body:{}});
  assert.equal(failed.connected,false);
  assert.equal(failed.cleanup.state,'unconfirmed');
  assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
  await assert.rejects(send(before.spec.target,{path:'/mcp'}),'local gateway is closed despite remote cleanup debt');
  fixture.failClose(false);
  await connectChatgpt({home,stop:true},{client,gozar:fixture.gozar,interaction});
  await assert.rejects(send(address,{path:'/mcp'}));
});

test('installed route consent preserves unknown cost and refuses prices on a free offer', {timeout:30000}, async t=>{
  const {stagedExposure} = await import('./helpers/gozar-fixture.mjs');
  const {createHosting} = await import('../lib/coordinator-hosting.mjs');
  const {prepareHosting} = await import('../lib/hosting-cli.mjs');
  const root = await mkdtemp(join(userInfo().homedir,'.tmp','fc-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const spec = {target:'127.0.0.1:24680',reach:'internet',address:'stable',usage:'attached'};
  const unknown = {kind:'unknown',summary:'Fixture price is unknown.'};
  const good = await stagedExposure(t,withCost(unknown));
  const controller = createHosting({directory:root,owner:'cost-test',api:good.gozar});
  let approved = 0;
  await prepareHosting(controller,spec,{
    choose:async offers=>{
      assert.deepEqual(offers[0].properties.cost,unknown);
      return offers[0];
    },
    driveSetup:async(_controller,operation)=>operation,
    approve:async snapshot=>{
      assert.deepEqual(snapshot.disclosures.cost,unknown);
      approved++;
      return true;
    },
  });
  assert.equal(approved,1);
  assert.equal(good.opened.size,0,'review alone allocates nothing');

  const bad = await stagedExposure(t,withCost({kind:'free',summary:'Invalid fixture',amount:0,currency:'USD',period:'month'}));
  const invalid = createHosting({directory:root,owner:'invalid-cost-test',api:bad.gozar});
  await assert.rejects(invalid.offers(spec),{code:'internal_error'});
  assert.equal(bad.opened.size,0);
});

test('setup reserves its ID, keeps browser handoff transient, and removes only an approved owned resource', {timeout:30000}, async t => {
  const {randomUUID,createHash} = await import('node:crypto');
  const {readFile,writeFile,readdir} = await import('node:fs/promises');
  const {createHosting,publishedOrigin} = await import('../lib/coordinator-hosting.mjs');
  const {hostingSecretBackend}=await import('../lib/hosting-secrets.mjs');
  const directory=await mkdtemp(join(userInfo().homedir,'.tmp','fh-'));
  const secret='canary-'+randomUUID(), handoff='https://auth.example.invalid/start?state='+randomUUID();
  const digest=createHash('sha256').update(secret).digest('hex');
  const disclosure={revision:'test-disclosure',text:'Allow this exact fixture effect.',links:[]};
  const action=(id, kind, purpose, fields={})=>({id,kind,label:id,digest:id,disclosure,
    step:{actor:'owner',permission:{id,label:id},verification:'provider',purpose},...fields});
  const secretAction=action('credential','provide-secret','authorize',{required:true,secretLabel:'Fixture credential'});
  const fixture=await gozarFixture(directory,{secretBackend:hostingSecretBackend(directory),setupActions:[secretAction],
    async extend(folder){
      const module=join(folder,'index.mjs');
      const source=(await readFile(module,'utf8')).replace('export default {','const base = {');
      await writeFile(module,source+`
import { writeFileSync } from 'node:fs';
const stateFile=new URL('./fixture.json',import.meta.url);
const read=()=>JSON.parse(readFileSync(stateFile));
const save=row=>writeFileSync(stateFile,JSON.stringify(row));
const step=(id,kind,purpose)=>({id,kind,label:id,digest:id,disclosure:${JSON.stringify(disclosure)},step:{actor:'owner',permission:{id,label:id},verification:'provider',purpose}});
export default {...base,
  async detect(ctx) {
    const seen=read();
    return {state:seen.phase==='complete'?'ready':'action-required',facts:{...seen,missing:seen.phase==='complete'?[]:[${JSON.stringify(secretAction)}]}};
  },
  async observeSetup(ctx,op) {
    const row=read(),observations=op.resources.map(resource=>({intentId:resource.id,subject:resource.subject,observedAt:new Date().toISOString(),
      status:row.owned?'present':'absent',identity:{id:'owned-resource-id'}}));
    const evidence={stepId:'factual-result',operationId:op.id,source:'provider',observedAt:new Date().toISOString(),summary:'Fixture observed the outcome.'};
    if(op.cancelled) {const nextAction=op.resources.length&&row.owned?step('remove','gozar-runs','remove-resource'):null;
      if(nextAction)nextAction.step.resourceHandle=op.resources[0].id;
      return {state:'cancelled',nextAction,observations,evidence};}
    if(row.phase==='initial')return {state:'authorization-required',nextAction:${JSON.stringify(secretAction)}};
    if(row.phase==='browser') {const nextAction=step('browser','open-url','authorize');
      nextAction.step.browser={expiresAt:row.expiresAt,pollAfterMs:1000};nextAction.href=row.handoff;
      return {state:'pending',nextAction};}
    if(row.phase==='blocked')return {state:'blocked',nextAction:step('instruction','instructions','reconcile')};
    if(row.phase==='allocate')return {state:'authorization-required',nextAction:step('provision','gozar-runs','provision'),
      intent:{kind:'other',label:'Owned fixture resource',subject:{resource:'one'}}};
    return {state:'complete',nextAction:null,observations,evidence};
  },
  async executeSetup(ctx,{action,intent,resource}) {
    const row=read();
    if(action.id==='credential'){
      await ctx.withInputSecret(async bytes=>{
        if(createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(digest)})throw Error('wrong credential');});
      save({...row,phase:'browser'});return {bindInputSecret:true};
    }
    if(action.id==='provision'&&intent){save({...row,phase:'complete',owned:true});
      await ctx.recordAllocation({id:'owned-resource-id'});return;}
    if(action.id==='remove'&&resource.identity.id==='owned-resource-id')save({...row,owned:false});
  }
};
`);
      await writeFile(join(folder,'fixture.json'),JSON.stringify({phase:'initial',owned:false,foreign:true,handoff,expiresAt:new Date(Date.now()+60000).toISOString()}));
    }});
  t.after(async()=>{await fixture.close();await rm(directory,{recursive:true,force:true});});
  const app=await startChatgptGateway({home:directory,localOrigin:()=> 'http://127.0.0.1:1'});
  t.after(()=>app.close());
  const file=join(fixture.folder,'fixture.json');
  const phase=async value=>writeFile(file,JSON.stringify({...JSON.parse(await readFile(file)),phase:value}));
  const args={directory,owner:'setup-test',api:fixture.gozar};
  let exposure=createHosting(args);
  const target='127.0.0.1:'+app.port, spec={target,usage:'attached',reach:'internet',address:'stable',protocols:[]};
  const [offer]=await exposure.offers(spec);
  await exposure.select(spec,offer);
  const submitted=await exposure.setup();
  assert.equal(exposure.read().setupOperationId,submitted.operationId);
  assert.equal(submitted.evidence.known,false);
  await assert.rejects(exposure.start(),{code:'setup_required'});
  const approval=op=>({operationId:op.operationId,revision:op.revision,consentFactsDigest:op.nextAction.consent.consentFactsDigest});
  await assert.rejects(exposure.acceptSetup({...approval(submitted),revision:99}),{code:'candidate_stale'});
  const {handle}=await exposure.intake({...approval(submitted),bytes:Buffer.from(secret)});
  const pending=await exposure.acceptSetup(approval(submitted),{secretHandle:handle});
  assert.equal(pending.state,'pending');
  assert.equal(pending.nextAction.href,undefined);
  exposure=createHosting(args);
  let launched;
  const browser=await exposure.setup();
  await exposure.browser(approval(browser),value=>{launched=value;});
  assert.equal(launched,handoff);
  assert.equal((await exposure.setup()).state,'pending','opening the browser supplies no completion evidence');
  await phase('blocked');
  assert.equal((await exposure.setup()).state,'blocked');
  await assert.rejects(exposure.start(),{code:'setup_required'});
  assert.equal(fixture.opened.size,0);
  await phase('allocate');
  const current=await exposure.setup();
  const complete=await exposure.acceptSetup(approval(current));
  assert.equal(complete.state,'complete');
  assert.equal(complete.evidence.known,true);
  assert.equal(complete.resources[0].removal,'required');
  assert.equal(fixture.opened.size,0,'setup does not publish a route');
  const [nowReady]=await exposure.offers(spec);
  const ready=await exposure.start(nowReady.approval);
  assert.equal(publishedOrigin(ready,target),ready.published);
  await exposure.close();
  const cancelled=await exposure.cancelSetup();
  assert.equal(cancelled.nextAction.step.resourceHandle,complete.resources[0].handle);
  const cleaned=await exposure.acceptSetup(approval(cancelled));
  assert.equal(cleaned.resources[0].removal,'confirmed');
  assert.equal(await exposure.finishSetupCleanup(cleaned),true);
  const remaining=JSON.parse(await readFile(file));
  assert.equal(remaining.owned,false);assert.equal(remaining.foreign,true);
  const all=await readdir(directory,{recursive:true});
  const text=await Promise.all(all.filter(name=>name.endsWith('.json')&&!name.startsWith('registry')).map(name=>readFile(join(directory,name),'utf8')));
  assert.ok(text.every(value=>!value.includes(secret)&&!value.includes(handoff)));
  assert.ok(!JSON.stringify([submitted,pending,browser,cancelled,cleaned]).includes(handoff));
});

test('the coordinator verifies its live HTTP challenge before serving and reuses a durable route', {timeout:30000}, async t => {
  const {createHosting,publishedOrigin}=await import('../lib/coordinator-hosting.mjs');
  const {startCoordinator}=await import('../lib/coordinator.mjs');
  const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
  const {randomUUID}=await import('node:crypto');
  const {readFile,writeFile}=await import('node:fs/promises');
  const directory=await mkdtemp(join(userInfo().homedir,'.tmp','fh-'));
  const fixture=await stagedExposure(t,{kind:'durable',reach:'tailnet'});
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=join(fixture.folder,'store.json');
  const data=JSON.parse(await readFile(store));
  const foreign={rule:{forward:'127.0.0.1:1'},foreign:true};
  await writeFile(store,JSON.stringify({...data,entries:{...data.entries,b:foreign}}));

  const v1={deferOrigin:true,origin:null,circlesDir:join(directory,'circles')};
  let coordinator=await startCoordinator({port:0,v1});
  t.after(async()=>{if(coordinator.listening)await stop(coordinator);});
  const port=coordinator.address().port, target='127.0.0.1:'+port;
  assert.equal((await send(target,{path:'/v1/capabilities'})).status,503);
  const hosting=createHosting({directory,owner:'coordinator-'+randomUUID(),api:fixture.gozar});
  const spec={target,reach:'tailnet',usage:'durable'};
  const [offer]=await hosting.offers(spec);
  assert.equal(offer.providerId,fixture.id);
  await hosting.select(spec,offer);
  const launchExposure=hosting.read();
  await assert.rejects(hosting.start(),{code:'consent_required'});
  assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
  const route=await hosting.start(offer.approval), origin=publishedOrigin(route,target);
  assert.ok(origin,'Gozar proved the coordinator challenge');
  const observed=await hosting.operationStatus(launchExposure);
  assert.equal(observed.operationId,launchExposure.routeOperationId);
  assert.deepEqual(observed.handle,route.handle);
  assert.equal(publishedOrigin(observed,target),origin);
  coordinator.configureOrigin(origin,route.verification.validUntil.value);
  const html=await send(target,{path:'/join'});
  assert.equal(html.status,404);
  assert.equal(JSON.parse(html.bytes).code,'circle_not_provisioned','proof cannot provision a circle');
  const previousHandle=route.handle;
  await stop(coordinator);
  coordinator=await startCoordinator({port,v1:{...v1,origin}});
  const resumed=await hosting.start();
  assert.deepEqual(resumed.handle,previousHandle);
  assert.equal(publishedOrigin(resumed,target),origin);
  coordinator.configureOrigin(origin,resumed.verification.validUntil.value);
  assert.deepEqual((await send(target,{path:'/join'})).bytes,html.bytes);
  fixture.failProof(true);
  const lost=await hosting.status();
  assert.equal(publishedOrigin(lost,target),null);
  coordinator.withdrawOrigin();
  assert.equal((await send(target,{path:'/join'})).status,503);
  fixture.failProof(false);
  assert.equal((await hosting.close()).cleanup.state,'confirmed');
  assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
});

test('Host issues a signed invite only after its verified route checkpoint', {timeout:30000}, async t => {
  const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
  const {coordinatorHosting,publishedOrigin}=await import('../lib/coordinator-hosting.mjs');
  const {startCoordinator}=await import('../lib/coordinator.mjs');
  const {ensureV1HostState,hostV1,provisionLocalCircle}=await import('../lib/v1/host.mjs');
  const {openDevice}=await import('../lib/v1/device.mjs');
  const {decodeInviteLink,verifyInvite}=await import('../lib/protocol/index.mjs');
  const fixture=await stagedExposure(t,{kind:'durable'});
  const home=await mkdtemp(join(userInfo().homedir,'.tmp','fi-'));
  const circlesDir=join(home,'v1','circles');
  const sentinel=createServer((_req,res)=>res.end('foreign'));
  let coordinator,exposure;
  try {
    await listen(sentinel);
    coordinator=await startCoordinator({port:0,v1:{deferOrigin:true,origin:null,circlesDir}});
    const port=coordinator.address().port,target='127.0.0.1:'+port;
    const store=join(fixture.folder,'store.json');
    const foreign={rule:{forward:'127.0.0.1:'+sentinel.address().port},foreign:true};
    const initial=JSON.parse(await readFile(store));
    await writeFile(store,JSON.stringify({...initial,entries:{...initial.entries,b:foreign}}));

    // The local process is fixture-owned; only the Host observation is withheld.
    // Keep the status file plausible so this reaches Host's matching-proof gate.
    let showProof=true;
    const sdk=new Proxy(fixture.gozar,{get(object,key){
      const value=object[key];
      if(typeof value!=='function')return value;
      if(key!=='routeStatus')return value.bind(object);
      return async request=>{
        const view=await value.call(object,request);
        return showProof ? view : {...view,verification:null};
      };
    }});
    exposure=coordinatorHosting(home,sdk);
    const spec={target,reach:'internet',usage:'durable'};
    const [offer]=await exposure.offers(spec);
    assert.ok(offer?.approval);
    await exposure.select(spec,offer);
    const route=await exposure.start(offer.approval);
    const approved=publishedOrigin(route,target);
    assert.ok(approved);
    const {paths,config}=ensureV1HostState({home,port,name:'Fixture circle'});
    await writeFile(paths.config,JSON.stringify({...config,reachability:{kind:'gozar'}}));
    await writeFile(paths.status,JSON.stringify({protocol_version:1,status:'public_listening',pid:process.pid,port,public_url:approved}));

    const device=await openDevice({home:join(home,'device'),origin:null,ensureDefault:false,ownerNameDefault:()=> 'Fixture owner',
      fetch:async (url,init)=>{
        const from=new URL(url);
        assert.equal(from.origin,approved,'the signed client uses only the fixture origin');
        const headers=new Headers(init?.headers);
        headers.set('host',from.host);
        return fetch('http://'+target+from.pathname+from.search,{...init,headers,redirect:'error'});
      }});
    const offline=await device.createCircle(null,{name:'Fixture circle',publish:false,deviceName:'Fixture device'});
    await assert.rejects(device.createInviteLinks(offline.id),{code:'origin_required'});

    let signerCalls=0;
    const seams={
      hostingApi:sdk,openDevice:async()=>({...device,
        async createInviteLinks(id){
          signerCalls++;
          const links=await device.createInviteLinks(id);
          // Select the public Host long-link path; the envelope comes from the real signer.
          return {...links,short:null};
        },
      }),
      portInUse:async()=>true,
      processExists:status=>status?.pid===process.pid&&status.port===port,
      startServer:async()=>assert.fail('must reuse the fixture coordinator'),
      provision:async args=>{
        coordinator.configureOrigin(approved,route.verification.validUntil.value);
        return provisionLocalCircle({...args,additional:true});
      },
    };
    const launch=()=>hostV1({home},seams);
    showProof=false;
    await assert.rejects(launch(),{code:'verification_failed'});
    assert.equal(signerCalls,0,'removing the Host proof gate would call the signer');
    assert.equal(device.selectCircle(offline.id).origin,null);

    showProof=true;
    const retried=await exposure.start();
    assert.deepEqual(retried.handle,route.handle);
    assert.equal(retried.operationId,route.operationId);
    const ready=await launch();
    assert.equal(ready.status,'ready');
    assert.equal(signerCalls,1);
    assert.equal(ready.config.v1_origin,approved);
    assert.equal(ready.circle.id,offline.id);
    assert.equal(ready.circle.pinnedRootFingerprint,offline.pinnedRootFingerprint);
    const decoded=decodeInviteLink(ready.invite);
    assert.ok(decoded.ok,'Host returned a real signed long invite');
    assert.equal(decoded.invite.payload.coordinator,approved);
    assert.ok(verifyInvite(decoded.invite,{rootFingerprint:offline.pinnedRootFingerprint,
      circle:offline.id,coordinator:approved,now:()=>Math.floor(Date.now()/1000)}).ok);

    showProof=false;
    await assert.rejects(launch(),{code:'verification_failed'});
    assert.equal(signerCalls,1,'withdrawn proof blocks new Host issuance only');
    assert.deepEqual(exposure.read().handle,route.handle);
    assert.equal(exposure.read().routeOperationId,route.operationId);
    assert.equal((await exposure.close()).cleanup.state,'confirmed');
    assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
  } finally {
    try {if(exposure?.read()?.handle)await exposure.close();}
    finally {
      if(coordinator?.listening)await stop(coordinator);
      if(sentinel.listening)await stop(sentinel);
      await rm(home,{recursive:true,force:true});
    }
  }
});

test('failed proof cannot publish or fall back, and an explicit restart uses a new operation', {timeout:30000}, async t => {
  const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
  const {createHosting,publishedOrigin}=await import('../lib/coordinator-hosting.mjs');
  const fixture=await stagedExposure(t);
  const directory=await mkdtemp(join(userInfo().homedir,'.tmp','fh-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=await startChatgptGateway({home:directory,localOrigin:()=> 'http://127.0.0.1:1'});
  const target='127.0.0.1:'+app.port, spec={target,reach:'internet',usage:'attached'};
  const exposure=createHosting({directory,owner:'proof-test',api:fixture.gozar});
  try {
    const [offer]=await exposure.offers(spec);
    await exposure.select(spec,offer);
    const operationId=exposure.read().routeOperationId;
    fixture.failProof(true);
    const check=error=>{
      assert.equal(error.code,'verification_failed');
      assert.equal(error.route.operationId,operationId);
      assert.equal(error.route.published,null);
      return true;
    };
    await assert.rejects(exposure.start(offer.approval),check);
    fixture.failProof(false);
    const replay=await exposure.start(offer.approval);
    assert.equal(replay.operationId,operationId);
    assert.equal(publishedOrigin(replay,target),null);
    assert.equal(fixture.opened.size,1,'same-operation retry did not allocate or fall back');
    assert.equal((await send(target,{path:'/mcp'})).status,503);
    assert.equal((await exposure.close()).cleanup.state,'confirmed');
    assert.notEqual(exposure.read().routeOperationId,operationId);
    const [restart]=await exposure.offers(spec);
    const ready=await exposure.start(restart.approval);
    assert.ok(publishedOrigin(ready,target));
    assert.equal(fixture.opened.size,2);
  } finally {
    try {await exposure.close();} finally {await app.close();}
  }
});

function heldCall() {
  let enter, release;
  return {entered:new Promise(resolve=>{enter=resolve;}),wait:new Promise(resolve=>{release=resolve;}),enter,release};
}

for (const phase of ['routeStatus','expose','gateway']) {
  test('Disconnect fences an admitted '+phase+' and a queued start through the real App', {timeout:45000}, async t => {
    const {readFile} = await import('node:fs/promises');
    const {createHash} = await import('node:crypto');
    const {stagedExposure,shortGozarAppHome,approveChatgpt} = await import('./helpers/gozar-fixture.mjs');
    const {appFixture,api} = await import('./helpers/v1-app-fixture.mjs');
    const {chatgptHosting} = await import('../lib/coordinator-hosting.mjs');
    const fixture=await stagedExposure(t), f=await appFixture(t);
    await shortGozarAppHome(t,f,'fenced');
    const gate=heldCall(), removed=heldCall(), calls=[], gateways=[];
    let armed=false, configured=0;
    const sdk=new Proxy(fixture.gozar,{get(target,key) {
      const value=target[key];
      if(typeof value!=='function')return value;
      if(!['routeStatus','expose','closeRoute'].includes(key))return value.bind(target);
      return async (...args)=>{
        if(key==='expose'||key==='closeRoute')calls.push({key,request:args[0]});
        if(armed&&key===phase) {armed=false;gate.enter();await gate.wait;}
        const result=await value.apply(target,args);
        if(key==='closeRoute'){calls.push({key:'closed',result});removed.enter();}
        return result;
      };
    }});
    const {app,home}=await f.start('fenced',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
      const gateway=await startChatgptGateway(options);
      const record={gateway,closes:0};gateways.push(record);
      const close=gateway.close, configure=gateway.configure;
      gateway.close=()=>{record.closes++;return close();};
      gateway.configure=(...args)=>{configured++;return configure(...args);};
      if(armed&&phase==='gateway'){armed=false;gate.enter();await gate.wait;}
      return gateway;
    }});
    const sentinel=createServer((req,res)=>res.end('foreign'));
    await listen(sentinel);
    t.after(()=>stop(sentinel));
    t.after(()=>gate.release());
    const request=body=>api(app,'/api/chatgpt/start',{method:'POST',body,status:409});
    let token, oauth, target, operationId;
    const config=()=>readFile(join(home,'v1','chatgpt-connect.json'),'utf8').then(JSON.parse);
    if(phase==='routeStatus') {
      await approveChatgpt(app,home,fixture);
      const gateway=gateways[0].gateway;
      target='127.0.0.1:'+gateway.port;oauth=gateway.oauth;
      const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
      const client=oauth.register({redirect_uris:[redirect],client_name:'held reconnect',token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
      const verifier='a'.repeat(64), challenge=createHash('sha256').update(verifier).digest('base64url');
      const pending=oauth.authorize(new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,
        response_type:'code',scope:'read',resource:oauth.resource,state:'held-reconnect',code_challenge:challenge,code_challenge_method:'S256'}));
      const approved=new URL(oauth.approve(pending.id,true,'read'));
      token=oauth.token({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,
        code:approved.searchParams.get('code'),code_verifier:verifier,resource:oauth.resource}).access_token;
      assert.ok(oauth.authenticate('Bearer '+token),'control: a live grant before Disconnect');
    } else if(phase==='expose') {
      const pending=await api(app,'/api/chatgpt/start',{method:'POST',body:{}});
      target=pending.spec.target;
      const exposure=chatgptHosting(join(home,'v1'),fixture.gozar);
      const [offer]=await exposure.offers(pending.spec);
      await exposure.select(pending.spec,offer);
      await exposure.authorize(offer.consent.consentFactsDigest,{binding:pending.approvalBinding});
    }
    operationId=chatgptHosting(join(home,'v1'),fixture.gozar).read()?.routeOperationId;
    const initialConfigured=configured;
    armed=true;
    const first=request({approveExposure:true});
    await gate.entered;
    // This second HTTP request is admitted while the same start is still held.
    const second=request({approveExposure:true});
    const disconnected=await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
    assert.equal(disconnected.connected,false);
    assert.equal(disconnected.cleanup.state,'unconfirmed');
    assert.equal(disconnected.cleanup.operationId,operationId??null);
    assert.equal((await config()).enabled,false);
    if(target)await assert.rejects(send(target,{path:'/mcp'}));
    if(oauth)assert.ok(!oauth.authenticate('Bearer '+token));
    assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
    // A new request cannot overlap the exact unsettled resource.
    await request({approveExposure:true});
    gate.release();
    await Promise.all([first,second]);
    if(phase!=='gateway')await removed.entered;
    // Explicit Disconnect joins retirement, not a replacement start.
    const final=await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
    assert.notEqual(final.cleanup?.state,'unconfirmed');
    assert.equal((await config()).enabled,false);
    assert.equal(configured,initialConfigured,'no stale configure/publication');
    assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
    for(const {gateway,closes} of gateways) {
      assert.equal(closes,1,'each startup-owned listener closes exactly once');
      await assert.rejects(send('127.0.0.1:'+gateway.port,{path:'/mcp'}));
    }
    assert.ok(calls.filter(row=>row.key==='expose').every(row=>row.request.operationId===operationId));
    assert.ok(calls.filter(row=>row.key==='closed').every(row=>row.result.operationId===operationId),
      'cleanup returns only the admitted operation');
    assert.equal(calls.filter(row=>row.key==='closeRoute').length,phase==='gateway'?0:1);
    const original=fixture.opened.values().next().value;
    if(original)assert.equal(original.server.listening,false);
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
  });
}

for (const [kind,debt] of [['attached',false],['attached',true],['durable',false]]) {
  test('enabled-config write failure retires the real gateway without losing '+kind+' ownership'+(debt?' with remote cleanup debt':''), {timeout:45000}, async t=>{
    const {readFile,rename,rm:remove} = await import('node:fs/promises');
    const {renameSync,mkdirSync} = await import('node:fs');
    const {stagedExposure,shortGozarAppHome} = await import('./helpers/gozar-fixture.mjs');
    const {appFixture,api} = await import('./helpers/v1-app-fixture.mjs');
    const {chatgptHosting} = await import('../lib/coordinator-hosting.mjs');
    const fixture=await stagedExposure(t,{kind}), f=await appFixture(t);
    await shortGozarAppHome(t,f,'write-failure');
    let gateway,configFile,closes=0,failed=false;
    const {app,home}=await f.start('write-failure',{chatgptGozar:fixture.gozar,chatgptStartGateway:async options=>{
      gateway=await startChatgptGateway(options);
      const configure=gateway.configure, close=gateway.close;
      gateway.configure=(...args)=>{
        configure(...args);
        // Fail only the enabled write, after real configure. No global filesystem mocking.
        renameSync(configFile,configFile+'.saved');mkdirSync(configFile);failed=true;
      };
      gateway.close=()=>{closes++;return close();};
      return gateway;
    }});
    configFile=join(home,'v1','chatgpt-connect.json');
    t.after(async()=>{if(failed){await remove(configFile,{recursive:true,force:true});await rename(configFile+'.saved',configFile);}});
    const sentinel=createServer((req,res)=>res.end('foreign'));
    await listen(sentinel);t.after(()=>stop(sentinel));
    const pending=await api(app,'/api/chatgpt/start',{method:'POST',body:{}});
    const exposure=chatgptHosting(join(home,'v1'),fixture.gozar);
    const spec={...pending.spec,usage:kind},[offer]=await exposure.offers(spec);
    await exposure.select(spec,offer);
    await exposure.authorize(offer.consent.consentFactsDigest,{binding:pending.approvalBinding});
    const original=exposure.read().routeOperationId;
    fixture.failClose(debt);
    const failure=await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
    assert.equal(failed,true,'control: the injected write failed after configure');
    assert.equal(failure.code,'EISDIR','cleanup does not replace the original write error');
    assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
    await assert.rejects(send(pending.spec.target,{path:'/mcp'}));
    assert.equal(closes,1);
    assert.equal(JSON.parse(await readFile(configFile+'.saved','utf8')).enabled,false);
    if(debt) {
      assert.equal(failure.cleanup.state,'unconfirmed');
      assert.equal(failure.cleanup.operationId,original);
      assert.equal(exposure.read().routeOperationId,original);
      await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
    } else {
      assert.notEqual(exposure.read().routeOperationId,original);
      assert.equal(exposure.read().handle,undefined);
      if(kind==='durable')assert.deepEqual(JSON.parse(await readFile(join(fixture.folder,'store.json'))).entries,{});
      assert.ok([...fixture.opened.values()].every(row=>!row.server.listening));
    }
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
    await remove(configFile,{recursive:true,force:true});
    await rename(configFile+'.saved',configFile);failed=false;
    fixture.failClose(false);
    // Explicit Disconnect retries any remaining cleanup debt.
    await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
  });
}

for (const debt of [false,true]) {
  test('durable shutdown removes the exact public route and preserves foreign ownership'+(debt?' after cleanup debt':''), {timeout:30000}, async t=>{
    const {createHosting,publishedOrigin}=await import('../lib/coordinator-hosting.mjs');
    const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
    const fixture=await stagedExposure(t,{kind:'durable'});
    const directory=await mkdtemp(join(userInfo().homedir,'.tmp','fr-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const app=await startChatgptGateway({home:directory,localOrigin:()=> 'http://127.0.0.1:1'});
    t.after(()=>app.close());
    const sentinel=createServer((req,res)=>res.end('foreign'));
    await listen(sentinel);t.after(()=>stop(sentinel));
    const store=join(fixture.folder,'store.json');
    const foreign={rule:{forward:'127.0.0.1:'+sentinel.address().port},foreign:true};
    const initial=JSON.parse(await readFile(store));
    await writeFile(store,JSON.stringify({...initial,entries:{...initial.entries,b:foreign}}));
    const calls=[];
    let refuse=debt;
    const sdk=new Proxy(fixture.gozar,{get(target,key){
      const value=target[key];
      if(typeof value!=='function')return value;
      if(key!=='closeRoute')return value.bind(target);
      return async request=>{
        calls.push(request);
        // Synthetic transport refusal before the real SDK side effect.
        if(refuse)throw Object.assign(new Error('synthetic removal unavailable'),{code:'synthetic_cleanup'});
        return value.call(target,request);
      };
    }});
    const exposure=createHosting({directory,owner:'durable-retirement',api:sdk});
    t.after(()=>exposure.close());
    const target='127.0.0.1:'+app.port, spec={target,reach:'internet',usage:'durable'};
    const [offer]=await exposure.offers(spec);
    await exposure.select(spec,offer);
    const route=await exposure.start(offer.approval);
    assert.ok(publishedOrigin(route,target),'control: installed SDK verified the public route');
    const before=JSON.parse(await readFile(store));
    assert.ok(Object.keys(before.entries).some(key=>key!=='b'),'control: an owned forwarding rule exists');
    if(debt){
      await assert.rejects(exposure.shutdown(),{code:'synthetic_cleanup'});
      assert.deepEqual(exposure.read().handle,route.handle);
      assert.equal(exposure.read().routeOperationId,route.operationId);
      assert.deepEqual(JSON.parse(await readFile(store)),before);
      refuse=false;
    }
    const closed=await exposure.shutdown();
    assert.equal(closed.cleanup.state,'confirmed');
    assert.equal(closed.operationId,route.operationId);
    assert.ok(calls.length>0);
    for(const request of calls){
      assert.deepEqual(request.handle,route.handle);
      assert.equal(request.mode,'remove');
      assert.equal(request.home,join(directory,'gz'));
    }
    assert.equal(exposure.read().handle,undefined);
    assert.notEqual(exposure.read().routeOperationId,route.operationId);
    assert.equal(exposure.read().spec.usage,'durable','selection intent is retained, not forwarding authority');
    assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
    await assert.rejects(exposure.start(),{code:'consent_required'});
    assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign},'resume without fresh consent allocates nothing');
  });
}

for (const outcome of ['confirmed', 'unconfirmed', 'throws']) {
  test('hostV1 launch rollback retires installed durable exposure: '+outcome, {timeout:30000}, async t=>{
    const {stagedExposure}=await import('./helpers/gozar-fixture.mjs');
    const {coordinatorHosting,publishedOrigin}=await import('../lib/coordinator-hosting.mjs');
    const {ensureV1HostState,hostV1}=await import('../lib/v1/host.mjs');
    const fixture=await stagedExposure(t,{kind:'durable'});
    const home=await mkdtemp(join(userInfo().homedir,'.tmp','fl-'));
    t.after(()=>rm(home,{recursive:true,force:true}));
    const app=await startChatgptGateway({home,localOrigin:()=> 'http://127.0.0.1:1'});
    t.after(()=>app.close());
    const target='127.0.0.1:'+app.port;
    const sentinel=createServer((req,res)=>res.end('foreign'));
    await listen(sentinel);t.after(()=>stop(sentinel));
    const store=join(fixture.folder,'store.json');
    const foreign={rule:{forward:'127.0.0.1:'+sentinel.address().port},foreign:true};
    const initial=JSON.parse(await readFile(store));
    await writeFile(store,JSON.stringify({...initial,entries:{...initial.entries,b:foreign}}));
    const {paths,config}=ensureV1HostState({home,port:app.port});
    await writeFile(paths.config,JSON.stringify({...config,host_wanted:true,reachability:{kind:'gozar'}}));
    const launchError=new Error('synthetic readiness failure');
    const localError=new Error('synthetic local stop refusal');
    const remoteError=new Error('synthetic close transport failure');
    const events=[],calls=[];
    let route, refuse=outcome!=='confirmed', remoteRoute;
    const sdk=new Proxy(fixture.gozar,{get(object,key){
      const value=object[key];
      if(typeof value!=='function')return value;
      if(key!=='closeRoute')return value.bind(object);
      return async request=>{
        calls.push(request);
        assert.deepEqual(events,['local-stop']);
        await assert.rejects(send(target,{path:'/mcp'}),'local listener is withdrawn before remote cleanup');
        if(refuse){
          remoteRoute={...route,cleanup:{state:'unconfirmed'}};
          if(outcome==='throws')throw Object.assign(remoteError,{route:remoteRoute});
          return remoteRoute;
        }
        return value.call(object,request);
      };
    }});
    const exposure=coordinatorHosting(home,sdk);
    t.after(async()=>{refuse=false;await exposure.close();});
    const spec={target,reach:'internet',usage:'durable'};
    const [offer]=await exposure.offers(spec);
    await exposure.select(spec,offer);
    const operationId=exposure.read().routeOperationId;
    await assert.rejects(hostV1({home,resume:{stopGeneration:null}},{
      hostingApi:sdk,openDevice:async()=>({}),portInUse:async()=>false,
      startServer:async()=>{
        route=await exposure.start(offer.approval);
        assert.equal(publishedOrigin(route,target),route.published,'positive installed public verification control');
        assert.ok(route.published);
        assert.ok(Object.keys(JSON.parse(await readFile(store)).entries).some(key=>key!=='b'));
        return {stop:async()=>{
          events.push('local-stop');
          await app.close();
          if(outcome!=='confirmed')throw localError;
        }};
      },
      waitReady:async()=>{throw launchError;},
    }),error=>{
      assert.strictEqual(error,launchError,'original launch failure is preserved');
      assert.equal(error.cleanupVerified,outcome==='confirmed');
      if(outcome==='confirmed'){
        assert.equal(error.cleanupError,undefined);
        assert.equal(error.exposureCleanupError,undefined);
      }else{
        assert.strictEqual(error.cleanupError,localError);
        if(outcome==='throws')assert.strictEqual(error.exposureCleanupError,remoteError);
        else assert.equal(error.exposureCleanupError.code,'cleanup_debt');
        assert.strictEqual(error.exposureCleanupError.route,remoteRoute);
      }
      return true;
    });
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0],{home:join(home,'gz'),handle:route.handle,mode:'remove'});
    assert.deepEqual(events,['local-stop']);
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
    const remaining=JSON.parse(await readFile(store));
    assert.deepEqual(remaining.entries.b,foreign);
    if(outcome==='confirmed'){
      assert.deepEqual(remaining.entries,{b:foreign});
      assert.equal(exposure.read().handle,undefined);
      assert.equal(exposure.read().pendingApproval,undefined);
      assert.notEqual(exposure.read().routeOperationId,operationId);
      await assert.rejects(exposure.start(),{code:'consent_required'});
      assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
    }else{
      assert.deepEqual(exposure.read().handle,route.handle);
      assert.equal(exposure.read().routeOperationId,operationId);
      assert.ok(Object.keys(remaining.entries).some(key=>key!=='b'));
      refuse=false;
      assert.equal((await exposure.close()).cleanup.state,'confirmed');
      assert.deepEqual(JSON.parse(await readFile(store)).entries,{b:foreign});
    }
  });
}

for(const rejection of ['invalid','roots','target','offer'])test('rejected live ChatGPT start preserves owned gateway and route: '+rejection,{timeout:45000},async t=>{
 const {stagedExposure,shortGozarAppHome,approveChatgpt}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {chatgptHosting}=await import('../lib/coordinator-hosting.mjs');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'preflight');
 let gateway,closes=0,routeCloses=0,opens=0;
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(!['catalogRoutes','expose','closeRoute'].includes(key))return value.bind(object);
  return async(...args)=>{if(key==='closeRoute')routeCloses++;if(key==='expose')opens++;return value.apply(object,args);};
 }});
 const {app,home}=await f.start('preflight',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  gateway=await startChatgptGateway(options);const close=gateway.close;
  gateway.close=()=>{closes++;return close();};return gateway;
 }});
 const live=await approveChatgpt(app,home,fixture);
 const original=gateway,exposure=chatgptHosting(join(home,'v1'),sdk),before=exposure.read();
 const forward=[...fixture.opened.values()][0],address='127.0.0.1:'+forward.server.address().port;
 assert.equal((await send(address,{path:'/mcp'})).status,401);
 const file=join(home,'v1','ce','exposure.json');
 if(rejection==='target')await writeFile(file,JSON.stringify({...before,spec:{...before.spec,target:'127.0.0.1:1'}}));
 try{
  const body=rejection==='invalid'?{approveExposure:false}:rejection==='roots'?{roots:[home]}:rejection==='offer'?{tunnel:'offer:other'}:{};
  const rejected=await api(app,'/api/chatgpt/start',{method:'POST',body,status:409});
  assert.equal(rejected.code,rejection==='invalid'?'invalid_request':'operation_conflict');
  assert.equal(closes,0);assert.equal(routeCloses,0);assert.equal(opens,1);
  assert.strictEqual(gateway,original);assert.equal(fixture.opened.size,1);
  assert.equal(forward.server.listening,true);
  assert.equal((await send(address,{path:'/mcp'})).status,401);
  const metadata=await send(address,{path:'/.well-known/oauth-protected-resource/mcp'});
  assert.equal(JSON.parse(metadata.bytes).resource,live.url);
  assert.deepEqual(exposure.read().handle,before.handle);
  assert.equal((await api(app,'/api/chatgpt/status')).url,live.url);
 }finally{if(rejection==='target')await writeFile(file,JSON.stringify(before));}
});

for(const fault of ['catalog','offer','binding','mutation'])test('App pending consent survives only preflight catalog failure: '+fault,{timeout:45000},async t=>{
 const {stagedExposure,shortGozarAppHome}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {chatgptHosting}=await import('../lib/coordinator-hosting.mjs');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'consent');
 let armed=false,opens=0,routeCloses=0,closes=0,gateway;
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(!['catalogRoutes','expose','closeRoute'].includes(key))return value.bind(object);
  return async(...args)=>{
   if(key==='closeRoute')routeCloses++;
   if(key==='catalogRoutes'&&armed){
    if(fault==='catalog'){armed=false;throw Object.assign(new Error('synthetic catalog unavailable'),{code:'synthetic_catalog'});}
    if(fault==='offer'){
     const result=await value.apply(object,args);
     return {...result,candidates:result.candidates.map(row=>({...row,consent:{...row.consent,consentFactsDigest:'changed-facts'}}))};
    }
   }
   if(key==='expose'){
    opens++;
    assert.equal(chatgptHosting(join(home,'v1'),sdk).read().pendingApproval,undefined,'consent consumed before route mutation');
    if(armed&&fault==='mutation'){armed=false;throw Object.assign(new Error('synthetic allocation rejection'),{code:'synthetic_allocation'});}
   }
   return value.apply(object,args);
  };
 }});
 const started=await f.start('consent',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  gateway=await startChatgptGateway(options);const close=gateway.close;
  gateway.close=()=>{closes++;return close();};return gateway;
 }});
 const {app,home}=started;
 const pending=await api(app,'/api/chatgpt/start',{method:'POST',body:{}});
 assert.equal(pending.status,'approval_required');
 const exposure=chatgptHosting(join(home,'v1'),sdk),spec={...pending.spec,usage:'attached'};
 const [choice]=await exposure.offers(spec);
 await exposure.select(spec,choice);
 await exposure.authorize(choice.consent.consentFactsDigest,{binding:fault==='binding'?'stale-binding':pending.approvalBinding});
 const approval=exposure.read().pendingApproval,original=gateway;
 armed=true;
 const failure=await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
 assert.equal(failure.code,fault==='catalog'?'synthetic_catalog':fault==='mutation'?'synthetic_allocation':'candidate_stale');
 if(fault==='mutation'){
  assert.equal(opens,1);assert.equal(closes,1);assert.equal(routeCloses,0);
  assert.equal(exposure.read().pendingApproval,undefined);
  assert.equal(fixture.opened.size,0);
  const retry=await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
  assert.equal(retry.code,'consent_required');
  assert.equal(opens,1,'attempted mutation cannot replay consumed consent');
  return;
 }
 assert.equal(closes,0);assert.equal(routeCloses,0);assert.equal(opens,0);
 assert.strictEqual(gateway,original);
 assert.equal((await send(pending.spec.target,{path:'/mcp'})).status,503,'pending gateway remains available');
 if(fault==='catalog'){
  assert.deepEqual(exposure.read().pendingApproval,approval);
  const live=await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true}});
  assert.equal(exposure.read().pendingApproval,undefined);
  assert.equal(opens,1);assert.equal(closes,0);assert.equal(routeCloses,0);
  assert.equal(fixture.opened.size,1);
  const forward=[...fixture.opened.values()][0];
  assert.equal((await send('127.0.0.1:'+forward.server.address().port,{path:'/mcp'})).status,401);
  assert.equal((await api(app,'/api/chatgpt/status')).url,live.url);
  await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true}});
  assert.equal(opens,1,'retry cannot allocate twice');
 }else{
  assert.equal(exposure.read().pendingApproval,undefined);
  armed=false;
  const retry=await api(app,'/api/chatgpt/start',{method:'POST',body:{approveExposure:true},status:409});
  assert.equal(retry.code,'consent_required');
  assert.equal(opens,0);assert.equal(closes,0);assert.equal(routeCloses,0);
 }
});


for(const failure of ['throw','end','rejected','expired','changed-handle','changed-target','changed-origin','changed-operation','direct-changed-operation','disconnect'])
test('ChatGPT watch recovery keeps only the exact verified live owner: '+failure,{timeout:45000},async t=>{
 const {stagedExposure,shortGozarAppHome,approveChatgpt}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {chatgptHosting}=await import('../lib/coordinator-hosting.mjs');
 const {setTimeout:pause}=await import('node:timers/promises');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'watch-recovery');
 const fault=heldCall(),recheck=heldCall(),returned=heldCall(),second=heldCall(),withdrawn=heldCall();
 const watches=[],statuses=[];
 let recovering=false,opens=0,gateway,configured=0,updates=0,closes=0;
 const aborted=signal=>signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 t.after(()=>{fault.release();recheck.release();});
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(key==='watchRoutes')return async function*(request){
   watches.push(request);
   if(watches.length===1){
    fault.enter();await Promise.race([fault.wait,aborted(request.signal)]);
    if(request.signal.aborted)return;
    recovering=true;
    if(failure==='direct-changed-operation'){
     const route=await object.routeStatus({home:request.home,handle:request.handle});
     yield {route:{...route,operationId:route.operationId+'-different'}};
     return;
    }
    if(failure==='end')return;
    throw new Error('synthetic watch transport failure');
   }
   second.enter();
   await aborted(request.signal);
  };
  if(key==='routeStatus')return async request=>{
   if(!recovering)return value.call(object,request);
   statuses.push(request);
   const view=await value.call(object,request);
   recheck.enter();await recheck.wait;
   try{
    if(failure==='rejected')throw new Error('synthetic status unavailable');
    if(failure==='changed-operation')return {...view,operationId:view.operationId+'-different'};
    if(failure==='expired')return {...view,verification:{...view.verification,validUntil:{known:true,value:'2000-01-01T00:00:00.000Z'}}};
    if(failure==='changed-handle')return {...view,handle:{...view.handle,generation:view.handle.generation+1},
     verification:{...view.verification,subject:{...view.verification.subject,handleGeneration:view.handle.generation+1}}};
    if(failure==='changed-target')return {...view,verification:{...view.verification,subject:{...view.verification.subject,target:'127.0.0.1:1'}}};
    if(failure==='changed-origin')return {...view,published:'https://other.invalid',
     verification:{...view.verification,subject:{...view.verification.subject,origin:'https://other.invalid'}}};
    return view;
   }finally{returned.enter();}
  };
  if(key==='expose')return async request=>{opens++;return value.call(object,request);};
  return value.bind(object);
 }});
 const {app,home}=await f.start('watch-recovery',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  gateway=await startChatgptGateway(options);
  const configure=gateway.configure,update=gateway.updateRoute,withdraw=gateway.withdraw,close=gateway.close;
  gateway.configure=(...args)=>{configured++;return configure(...args);};
  gateway.updateRoute=(...args)=>{updates++;return update(...args);};
  gateway.withdraw=()=>{withdraw();withdrawn.enter();};
  gateway.close=()=>{closes++;return close();};
  return gateway;
 }});
 const live=await approveChatgpt(app,home,fixture);
 await fault.entered;
 const original=gateway,oauth=gateway.oauth,listener=gateway.server;
 const exposure=chatgptHosting(join(home,'v1'),sdk),owner=exposure.read();
 const forward=[...fixture.opened.values()][0],address='127.0.0.1:'+forward.server.address().port;
 assert.equal((await send(address,{path:'/mcp'})).status,401);
 assert.equal(configured,1);assert.equal(opens,1);
 let initialize, grantId;
 if(['throw','end'].includes(failure)){
  const {createHash}=await import('node:crypto');
  const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
  const client=oauth.register({redirect_uris:[redirect],client_name:'watch recovery fixture',token_endpoint_auth_method:'none',
   grant_types:['authorization_code','refresh_token'],response_types:['code']});
  const verifier='a'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorization=oauth.authorize(new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,
   response_type:'code',scope:'read',resource:oauth.resource,state:'watch-recovery',code_challenge:challenge,code_challenge_method:'S256'}));
  const approved=new URL(oauth.approve(authorization.id,true,'read'));
  const token=oauth.token({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,
   code:approved.searchParams.get('code'),code_verifier:verifier,resource:oauth.resource}).access_token;
  grantId=oauth.authenticate('Bearer '+token)?.id;
  assert.equal(typeof grantId,'string','control: one synthetic grant was issued');
  initialize=async id=>{
   assert.equal(gateway.oauth.authenticate('Bearer '+token)?.id,grantId,'reuse the original token and grant');
   const response=await send(address,{path:'/mcp',method:'POST',headers:{authorization:'Bearer '+token,
    'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2024-11-05',
     capabilities:{},clientInfo:{name:'watch-recovery-fixture',version:'1'}}})});
   assert.equal(response.status,200,'authenticated initialize crosses the owned loopback forwarder');
   const message=JSON.parse(response.bytes);
   assert.equal(message.jsonrpc,'2.0');assert.equal(message.id,id);assert.equal(message.error,undefined);
   assert.equal(message.result.serverInfo.name,'faravan');
   assert.equal(typeof message.result.protocolVersion,'string');
  };
  await initialize(1);
 }
 fault.release();
 if(failure==='direct-changed-operation'){
  await withdrawn.entered;
  assert.equal(watches[0].signal.aborted,true);
  assert.deepEqual(statuses,[],'a direct invalid event does not trigger a status recheck');
  assert.equal(watches.length,1);
  assert.equal(updates,0);
  assert.equal(opens,1);
  assert.equal(configured,1);
  assert.deepEqual(await api(app,'/api/chatgpt/status'),{connected:false,audit:[]});
  return;
 }
 await recheck.entered;
 assert.deepEqual(statuses,[{home:join(home,'v1','ce','gz'),handle:owner.handle}]);
 assert.strictEqual(gateway.oauth,oauth,'transport failure alone cannot revoke the owner');
 assert.equal((await send(address,{path:'/mcp'})).status,401);
 if(failure==='disconnect'){
  const disconnected=await api(app,'/api/chatgpt/disconnect',{method:'POST',body:{}});
  assert.equal(disconnected.connected,false);
  assert.equal(listener.listening,false);
  assert.equal(watches[0].signal.aborted,true);
  recheck.release();await returned.entered;
  await pause(350); // Beyond the bounded retry delay: stale status must not start another watcher.
  assert.equal(watches.length,1);assert.equal(updates,0);assert.equal(configured,1);
  assert.equal(gateway.oauth,null);assert.equal(closes,1);
  assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
 }else{
  recheck.release();await returned.entered;
  if(['throw','end'].includes(failure)){
   await second.entered;
   await initialize(2);
   assert.equal(watches.length,2);assert.equal(updates,1);assert.equal(closes,0);
   assert.strictEqual(gateway,original);assert.strictEqual(gateway.server,listener);
   assert.strictEqual(gateway.oauth,oauth,'successful recheck must not replace the OAuth owner');
   assert.equal(listener.listening,true);assert.equal(forward.server.listening,true);
   assert.deepEqual(exposure.read().handle,owner.handle);
   assert.equal(exposure.read().routeOperationId,owner.routeOperationId);
   assert.deepEqual(watches.map(row=>row.handle),[owner.handle,owner.handle]);
   assert.equal((await send(address,{path:'/mcp'})).status,401);
   const metadata=await send(address,{path:'/.well-known/oauth-protected-resource/mcp'});
   assert.equal(JSON.parse(metadata.bytes).resource,live.url);
  }else{
   await withdrawn.entered;
   assert.equal(gateway.oauth,null);assert.equal(updates,0);assert.equal(watches.length,1);
   assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
   assert.equal((await send(address,{path:'/mcp'})).status,503);
   assert.equal(watches[0].signal.aborted,true);
  }
 }
 assert.equal(opens,1,'watch recovery never allocates another route');
 assert.equal(fixture.opened.size,1);
 assert.equal(configured,1,'watch recovery never configures a replacement owner');
});


for(const late of ['resolve','reject'])
test('ChatGPT held watch recheck expires without republishing on late '+late,{timeout:45000},async t=>{
 const {stagedExposure,shortGozarAppHome,approveChatgpt}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {setTimeout:pause}=await import('node:timers/promises');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'watch-deadline');
 const fault=heldCall(),held=heldCall(),returned=heldCall(),withdrawn=heldCall();
 const requests=[],watches=[];
 let recovering=false,gateway,configured=0,updates=0,opens=0,closes=0,readSettled=false;
 const aborted=signal=>signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 t.after(()=>{fault.release();held.release();});
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(key==='watchRoutes')return async function*(request){
   watches.push(request);fault.enter();
   await Promise.race([fault.wait,aborted(request.signal)]);
   if(request.signal.aborted)return;
   recovering=true;throw new Error('synthetic watch failure');
  };
  if(key==='routeStatus')return async request=>{
   if(!recovering)return value.call(object,request);
   requests.push(request);
   const verified=await value.call(object,request);
   held.enter();await held.wait;
   try{
    if(late==='reject')throw new Error('synthetic late status rejection');
    return verified;
   }finally{readSettled=true;returned.enter();}
  };
  if(key==='expose')return async request=>{opens++;return value.call(object,request);};
  return value.bind(object);
 }});
 const {app,home}=await f.start('watch-deadline',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  gateway=await startChatgptGateway(options);
  const configure=gateway.configure,update=gateway.updateRoute,withdraw=gateway.withdraw,close=gateway.close;
  gateway.configure=(...args)=>{configured++;return configure(...args);};
  gateway.updateRoute=(...args)=>{updates++;return update(...args);};
  gateway.withdraw=()=>{withdraw();withdrawn.enter();};
  gateway.close=()=>{closes++;return close();};
  return gateway;
 }});
 await approveChatgpt(app,home,fixture);await fault.entered;
 const oauth=gateway.oauth,listener=gateway.server;
 const forward=[...fixture.opened.values()][0],address='127.0.0.1:'+forward.server.address().port;
 assert.equal((await send(address,{path:'/mcp'})).status,401);
 fault.release();await held.entered;
 assert.strictEqual(gateway.oauth,oauth);
 assert.equal(requests.length,1);
 assert.deepEqual(requests[0],{home:join(home,'v1','ce','gz'),handle:watches[0].handle});
 // A real deadline, not a production timing seam or global mock that affects App IO.
 const guard=new AbortController();
 try{
  await Promise.race([withdrawn.entered,pause(7000,undefined,{signal:guard.signal}).then(()=>{
   throw new Error('held recheck did not withdraw within its observation bound');
  })]);
 }finally{guard.abort();}
 assert.equal(readSettled,false,'withdrawal must precede uncooperative read settlement');
 assert.equal(watches[0].signal.aborted,true);
 assert.equal(gateway.oauth,null);assert.equal(updates,0);
 assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
 assert.equal((await send(address,{path:'/mcp'})).status,503);
 assert.strictEqual(gateway.server,listener);assert.equal(listener.listening,true);
 assert.equal(closes,0,'timeout withdraws publication, not exact-owner cleanup');
 held.release();await returned.entered;
 await pause(350); // Past the normal resubscription delay; late results must be inert.
 assert.equal(readSettled,true);assert.equal(watches.length,1);
 assert.equal(configured,1);assert.equal(updates,0);assert.equal(gateway.oauth,null);
 assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
 assert.equal((await send(address,{path:'/mcp'})).status,503);
 assert.equal(opens,1);assert.equal(fixture.opened.size,1);
});

test('ChatGPT held recheck retains publication until the admitted short proof expires',{timeout:45000},async t=>{
 const {stagedExposure,shortGozarAppHome,approveChatgpt}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {setTimeout:pause}=await import('node:timers/promises');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'short-proof');
 const emit=heldCall(),fault=heldCall(),admitted=heldCall(),held=heldCall(),returned=heldCall(),withdrawn=heldCall();
 const watches=[],requests=[];
 let gateway,shortView,expiresAt,withdrewAt,recovering=false,readSettled=false,updates=0,configured=0,opens=0;
 const aborted=signal=>signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 t.after(()=>{emit.release();fault.release();held.release();});
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(key==='watchRoutes')return async function*(request){
   watches.push(request);
   await Promise.race([emit.wait,aborted(request.signal)]);
   if(request.signal.aborted)return;
   const verified=await object.routeStatus({home:request.home,handle:request.handle});
   // Begin the short lifetime only after App startup and the initial HTTP control.
   expiresAt=Date.now()+2500;
   shortView={...verified,verification:{...verified.verification,
    validUntil:{known:true,value:new Date(expiresAt).toISOString()}}};
   yield {route:shortView};
   await Promise.race([fault.wait,aborted(request.signal)]);
   if(request.signal.aborted)return;
   recovering=true;throw new Error('synthetic short-proof watch failure');
  };
  if(key==='routeStatus')return async request=>{
   if(!recovering)return value.call(object,request);
   requests.push(request);held.enter();await held.wait;
   readSettled=true;returned.enter();return shortView;
  };
  if(key==='expose')return async request=>{opens++;return value.call(object,request);};
  return value.bind(object);
 }});
 const {app,home}=await f.start('short-proof',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  gateway=await startChatgptGateway(options);
  const configure=gateway.configure,update=gateway.updateRoute,withdraw=gateway.withdraw;
  gateway.configure=(...args)=>{configured++;return configure(...args);};
  gateway.updateRoute=view=>{
   const result=update(view);updates++;
   if(view.verification.validUntil.value===shortView?.verification.validUntil.value)admitted.enter();
   return result;
  };
  gateway.withdraw=()=>{withdrewAt=Date.now();withdraw();withdrawn.enter();};
  return gateway;
 }});
 await approveChatgpt(app,home,fixture);
 const oauth=gateway.oauth,listener=gateway.server;
 const forward=[...fixture.opened.values()][0],address='127.0.0.1:'+forward.server.address().port;
 assert.equal((await send(address,{path:'/mcp'})).status,401,'initial verified publication');
 emit.release();await admitted.entered;
 assert.equal(updates,1,'App admitted the short-proof watch event');
 assert.strictEqual(gateway.oauth,oauth);
 fault.release();await held.entered;
 assert.deepEqual(requests,[{home:join(home,'v1','ce','gz'),handle:watches[0].handle}]);
 const heldAt=Date.now();
 assert.ok(expiresAt-heldAt>=1500,'fixture must leave a meaningful proof lifetime after admission');
 await pause(400);
 assert.equal(withdrewAt,undefined,'held recheck must not withdraw immediately');
 assert.equal(readSettled,false);
 assert.strictEqual(gateway.oauth,oauth);
 assert.equal((await send(address,{path:'/mcp'})).status,401,'publication survives a meaningful held-read interval');
 assert.ok(Date.now()<expiresAt-250,'positive control must precede expiry, not race it');
 const guard=new AbortController();
 try{
  await Promise.race([withdrawn.entered,pause(Math.max(1,expiresAt+900-Date.now()),undefined,{signal:guard.signal}).then(()=>{
   throw new Error('held recheck ignored the earlier proof deadline');
  })]);
 }finally{guard.abort();}
 assert.ok(withdrewAt>=expiresAt-100,'withdrawal must not precede proof expiry');
 assert.ok(withdrewAt<=expiresAt+900,'withdrawal must follow the short proof, not the five-second cap');
 assert.ok(withdrewAt-heldAt<4000,'fixed five-second observation would fail');
 assert.equal(readSettled,false,'deadline withdraws while the SDK read is still pending');
 assert.equal(watches[0].signal.aborted,true);
 assert.equal(gateway.oauth,null);assert.equal(updates,1);
 assert.equal((await api(app,'/api/chatgpt/status')).connected,false);
 assert.equal((await send(address,{path:'/mcp'})).status,503);
 assert.strictEqual(gateway.server,listener);assert.equal(listener.listening,true);
 held.release();await returned.entered;await pause(350);
 assert.equal(watches.length,1);assert.equal(updates,1);assert.equal(configured,1);
 assert.equal(gateway.oauth,null);assert.equal(opens,1);assert.equal(fixture.opened.size,1);
});


for(const rejectClose of [false,true])test('fresh App preserves restored approval when only its new listener preceded catalog failure (close rejects: '+rejectClose+')',{timeout:45000},async t=>{
 const {createHash}=await import('node:crypto');
 const {stagedExposure,shortGozarAppHome}=await import('./helpers/gozar-fixture.mjs');
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {chatgptHosting}=await import('../lib/coordinator-hosting.mjs');
 const fixture=await stagedExposure(t),f=await appFixture(t);
 await shortGozarAppHome(t,f,'restored-consent');
 const home=f.homes.get('restored-consent'),roots=[];
 // Persist a valid pre-allocation selection/approval without starting an App.
 const seed=await startChatgptGateway({home,localOrigin:()=> 'http://127.0.0.1:1'});
 const port=seed.port,target='127.0.0.1:'+port;
 await seed.close();
 await mkdir(join(home,'v1'),{mode:0o700});
 const savedExposure=chatgptHosting(join(home,'v1'),fixture.gozar);
 const spec={target,reach:'internet',address:'stable',usage:'attached',protocols:['streamable-http','oauth-dcr']};
 const [choice]=await savedExposure.offers(spec);
 await savedExposure.select(spec,choice);
 const binding=createHash('sha256').update(JSON.stringify(roots)).digest('hex');
 await savedExposure.authorize(choice.consent.consentFactsDigest,{binding});
 const before=savedExposure.read();
 assert.ok(before.pendingApproval);assert.equal(before.handle,undefined);
 const config={schemaVersion:1,enabled:false,port,roots};
 await writeFile(join(home,'v1','chatgpt-connect.json'),JSON.stringify(config));
 let failCatalog=true,catalogs=0;
 const mutations=[],gateways=[];
 let releaseClose,signalClose;
 const closeHeld=new Promise(resolve=>{releaseClose=resolve;});
 const closeEntered=new Promise(resolve=>{signalClose=resolve;});
 t.after(()=>releaseClose());
 const sdk=new Proxy(fixture.gozar,{get(object,key){
  const value=object[key];if(typeof value!=='function')return value;
  if(key==='catalogRoutes')return async request=>{
   catalogs++;
   if(failCatalog){failCatalog=false;throw Object.assign(new Error('synthetic restored catalog failure'),{code:'synthetic_catalog'});}
   return value.call(object,request);
  };
  if(['expose','ensureRoute','runSetupAction','closeRoute','cancelSetupOperation'].includes(key))
   return async request=>{mutations.push({key,request,gateway:gateways.at(-1)});return value.call(object,request);};
  return value.bind(object);
 }});
 const {app}=await f.start('restored-consent',{chatgptGozar:sdk,chatgptStartGateway:async options=>{
  if(gateways.length) {
   assert.equal(gateways[0].gateway.server.listening,false,'old listener closed before replacement');
   assert.equal(gateways[0].closes,rejectClose?2:1,'rejected close was actually retried');
   assert.deepEqual(savedExposure.read(),before,'approval untouched before healthy listener admission');
   assert.deepEqual(mutations,[]);
   assert.equal(catalogs,1);
   await assert.rejects(send(target,{path:'/mcp'}));
  }
  const gateway=await startChatgptGateway(options),record={gateway,closes:0,configures:0};
  gateways.push(record);const close=gateway.close;
  const configure=gateway.configure;
  gateway.configure=(...args)=>{record.configures++;return configure(...args);};
  gateway.close=async()=>{
   record.closes++;
   if(gateways[0]===record&&record.closes===1){
    signalClose();await closeHeld;await close();
    if(rejectClose)throw new Error('synthetic local close rejection after real close');
    return;
   }
   return close();
  };
  return gateway;
 }});
 assert.equal(gateways.length,0,'disabled restored profile has no in-memory gateway');
 const body={approveExposure:true};
 const first=api(app,'/api/chatgpt/start',{method:'POST',body,status:409});
 await closeEntered;
 assert.equal(gateways.length,1);
 assert.deepEqual(savedExposure.read(),before);
 assert.deepEqual(mutations,[],'read-only catalog failure cannot trigger route/setup cleanup');
 assert.equal(fixture.opened.size,0);
 assert.deepEqual(JSON.parse(await readFile(join(home,'v1','chatgpt-connect.json'))),config);
 // Queue an approved Start while exact local cleanup is still in flight.
 const queued=new Promise(resolve=>{
  const observe=req=>{
   if(req.url!=='/api/chatgpt/start')return;
   app.server.off('request',observe);
   req.once('end',()=>setImmediate(resolve));
  };
  app.server.on('request',observe);
  t.after(()=>app.server.off('request',observe));
 });
 const second=api(app,'/api/chatgpt/start',{method:'POST',body});
 await queued;
 assert.equal(gateways.length,1,'queued Start cannot bind before exact cleanup settles');
 assert.equal(gateways[0].configures,0);
 assert.deepEqual(savedExposure.read(),before);
 releaseClose();
 const failed=await first;
 assert.equal(failed.code,'synthetic_catalog','preserve the original preflight error');
 const live=await second;
 assert.equal(gateways[0].closes,rejectClose?2:1);
 assert.equal(gateways[0].configures,0,'never configure the retired listener');
 assert.equal(gateways[0].gateway.server.listening,false);
 assert.equal(gateways.length,2);assert.equal(gateways[1].gateway.port,port);
 assert.equal(gateways[1].closes,0);
 assert.equal(savedExposure.read().pendingApproval,undefined);
 assert.equal(savedExposure.read().routeOperationId,before.routeOperationId);
 assert.equal(savedExposure.read().spec.target,target);
 assert.deepEqual(mutations.map(row=>row.key),['expose']);
 assert.equal(mutations[0].request.operationId,before.routeOperationId);
 assert.equal(mutations[0].gateway,gateways[1],'expose belongs only to the replacement listener');
 assert.equal(gateways[1].configures,1);
 assert.equal(fixture.opened.size,1);
 const forward=[...fixture.opened.values()][0],address='127.0.0.1:'+forward.server.address().port;
 assert.equal((await send(address,{path:'/mcp'})).status,401);
 const metadata=await send(address,{path:'/.well-known/oauth-protected-resource/mcp'});
 assert.equal(JSON.parse(metadata.bytes).resource,live.url);
 assert.equal((await api(app,'/api/chatgpt/status')).url,live.url);
 await api(app,'/api/chatgpt/start',{method:'POST',body});
 assert.deepEqual(mutations.map(row=>row.key),['expose'],'consumed approval cannot allocate again');
 assert.equal(savedExposure.read().pendingApproval,undefined);
});
