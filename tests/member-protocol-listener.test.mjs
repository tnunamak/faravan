import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {appFixture,waitFor} from './helpers/v1-app-fixture.mjs';
import {listen,stop,send} from './helpers/gozar-fixture.mjs';
import {createHosting,publishedOrigin} from '../lib/coordinator-hosting.mjs';
import {createMemberServing} from '../lib/v1/member-serving.mjs';
import {createMemberListener} from '../lib/v1/member-listener.mjs';

// The app-owned protocol-only member listener: its own loopback target for the exposure route, no
// tray/session/phone/MCP/account route behind it, a fixed shutdown order (fence, retire the exact
// route, drain or terminate admitted work, close the stores), and exact route cleanup that survives a
// reopen. Gozar is the installed testing export (no real provider, no network).

const publicOrigin='https://member.example';

test('the member listener serves only the signed protocol and shuts down in order',{timeout:300000},async t=>{
  const f=await appFixture(t);
  const {owner,lender,circle}=await f.realConnect({lenderOptions:{}});
  const lenderId=lender.app.device.keyId;
  await owner.app.device.setMemberOrigin(circle.id,lenderId,publicOrigin);
  await lender.app.device.refreshRoster(circle.id);
  const roster=(await lender.app.device.rosterCache(circle.id).get()).current;
  const path='/v1/circles/'+circle.id+'/roster';
  const ownerKey=owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey;
  const proofFor=(method,target,body=Buffer.alloc(0))=>p.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method,target,
    body,content_type:method==='PUT'?'application/json':'',artifact_media_type:'',idempotency_key:'',
    created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},ownerKey);
  const reach=(port,headers,{method='GET',target='/'}={})=>send('127.0.0.1:'+port,{path:target,method,headers}).then(r=>({status:r.status,body:r.bytes.toString()}));

  await t.test('exact signed request works under a public or rewritten loopback Host; everything else is refused here',async()=>{
    const {port,target}=await lender.app.memberListener.start();
    assert.equal(target,'127.0.0.1:'+port);
    assert.notEqual(String(port),new URL(lender.app.origin).port,'its own loopback port, not the tray port');
    for(const host of ['member.example','127.0.0.1:'+port,'localhost:'+port]) {
      const served=await reach(port,{host,'faravan-proof':proofFor('GET',publicOrigin+path)},{target:path});
      assert.equal(served.status,200,host+': '+served.body.slice(0,160));
      assert.equal(JSON.parse(served.body).payload.epoch,roster.payload.epoch);
    }
    const wrong=await reach(port,{host:'127.0.0.1:'+port,'faravan-proof':proofFor('GET','https://other.example'+path)},{target:path});
    assert.ok(wrong.status>=400&&wrong.status<500,'a wrong proof is refused: '+wrong.status);
    assert.equal((await reach(port,{host:'127.0.0.1:'+port},{target:path})).status>=400,true,'unsigned is refused');
    // No tray, phone, MCP, session or account route exists on this port, whatever Host or session credential rides along.
    for(const target of ['/','/index.html','/api/status','/api/jobs','/api/handoff','/auth/handoff?code=x','/mcp','/phone','/favicon.svg',
      '/api/account-proxy/codex/v1/x','/v1/circles/'+circle.id+'/../../api/status','/v1/circles/'+circle.id+'/%2e%2e/api/status','//api/status']) {
      for(const host of ['127.0.0.1:'+port,'member.example']) {
        const refused=await reach(port,{host,cookie:'faravan_local_session_x=1','x-faravan-session-token':lender.app.token,
          authorization:'Bearer '+lender.app.token},{target});
        assert.equal(refused.status,404,host+' '+target);
        assert.deepEqual(JSON.parse(refused.body),{code:'not_found'},'only the listener answered: '+target);
      }
    }
    // The tray port still enforces its own rules and does not serve the protocol.
    assert.equal((await reach(new URL(lender.app.origin).port,{host:'127.0.0.1:'+new URL(lender.app.origin).port},{target:'/api/status'})).status,401);
    assert.equal((await reach(new URL(lender.app.origin).port,{host:'member.example','faravan-proof':proofFor('GET',publicOrigin+path)},{target:path})).status,403);
    await lender.app.memberListener.close(); // release the store for the ordered-shutdown round below
  });

  await t.test('close fences, retires the exact route, drains or terminates, then closes the store; retry removes only that route',async()=>{
    const base=join(userInfo().homedir,'.tmp');
    const directory=await mkdtemp(join(base,'ml-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    // A fake provider seam: it models only what the hosting wrapper asks of Gozar. A route forwards to exactly the
    // target it was installed for, and a close removes exactly its own handle, never another owner's route.
    const sentinel=createServer((req,res)=>res.end('foreign'));
    await listen(sentinel);t.after(()=>stop(sentinel));
    const routes=new Map([['foreign-route',{handle:{id:'foreign-route',generation:1},owner:'someone-else',target:'127.0.0.1:'+sentinel.address().port}]]);
    const closeCalls=[];
    let refuse=true;
    const view=route=>({handle:route.handle,operationId:route.operationId,state:'usable',published:publicOrigin,
      verification:{status:'verified',subject:{origin:publicOrigin,target:route.target,handleGeneration:route.handle.generation},
        validUntil:{known:true,value:new Date(Date.now()+3600000).toISOString()}},binding:{target:{known:true,value:route.target}},
      cleanup:{state:'confirmed'}});
    const sdk={
      async catalogRoutes(){return {candidates:[{eligible:true,providerId:'fake',display:'fake',properties:{},configuration:{revision:1},
        setup:{state:'ready',actions:[]},consent:{consentFactsDigest:'sha256:fake'},candidateToken:'token',disclosure:{revision:'r1'}}]};},
      async ensureRoute(request){
        const known=[...routes.values()].find(row=>row.owner===request.owner&&row.operationId===request.operationId);
        const route=known??{handle:{id:'route-'+routes.size,generation:1},owner:request.owner,operationId:request.operationId,target:request.target};
        routes.set(route.handle.id,route);return view(route);
      },
      async routeStatus({handle}){const route=routes.get(handle.id);return route?view(route):null;},
      async listRoutes({owner}){return {routes:[...routes.values()].filter(row=>row.owner===owner)};},
      async closeRoute(call){
        closeCalls.push({call,inFlight:member?.listener.inFlight()});
        if(refuse)throw Object.assign(new Error('synthetic removal unavailable'),{code:'synthetic_cleanup'});
        const route=routes.get(call.handle.id);
        routes.delete(call.handle.id);
        return {handle:call.handle,operationId:route.operationId,cleanup:{state:'confirmed'}};
      },
    };
    // What the provider does with public traffic: forward to the installed target, rewriting Host as it chooses.
    const forward=(handle,{host,...rest},target)=>send(routes.get(handle.id).target,{path:target,headers:{host,...rest}});
    const lenderHome=await f.home('lender');
    let member=null;
    const open=({drainMs})=>{
      const real=createMemberServing({home:lenderHome,device:lender.app.device});
      const events=[];
      const hosting=createHosting({directory,owner:'member-listener',api:sdk});
      let retired=null;
      const serving={ensure:real.ensure,
        quiesce:()=>{events.push('terminate');real.quiesce();},
        close:async()=>{events.push('stores-closed with '+listener.inFlight()+' in flight');return real.close();}};
      const listener=createMemberListener({serving,file:join(directory,'member-listen.json'),drainMs,
        retire:async()=>{events.push('retire');retired=await hosting.shutdown();return retired;}});
      member={listener,hosting,events,retired:()=>retired};
      return member;
    };
    const held=(port,{complete})=>{
      const body=Buffer.from(p.canonicalize(roster));
      const req=request({host:'127.0.0.1',port,path,method:'PUT',headers:{host:'member.example','content-type':'application/json',
        'content-length':body.length,'faravan-proof':proofFor('PUT',publicOrigin+path,body)}});
      const response=new Promise((resolve,reject)=>{
        req.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
      });
      response.catch(()=>{});
      req.write(body.subarray(0,16));
      return {response,finish:()=>req.end(body.subarray(16))};
    };

    // Round 1: the route is installed for exactly the listener's loopback target; a short request is mid-flight.
    const one=open({drainMs:20000});
    const {port,target}=await one.listener.start();
    const spec={target,reach:'internet',usage:'durable'};
    const [offer]=await one.hosting.offers(spec);
    await one.hosting.select(spec,offer);
    const route=await one.hosting.start(offer.approval);
    assert.ok(publishedOrigin(route,target),'control: the installed route targets the member listener');
    assert.equal(routes.get(route.handle.id).target,target,'the owned route forwards to exactly the listener target');
    const rules=new Map(routes);
    for(const host of ['member.example','127.0.0.1:'+port]) {
      const viaRoute=await forward(route.handle,{host,'faravan-proof':proofFor('GET',publicOrigin+path)},path);
      assert.equal(viaRoute.status,200,'through the route under Host '+host);
    }
    const viaTray=await forward(route.handle,{host:'127.0.0.1:'+port},'/api/status');
    assert.equal(viaTray.status,404,'a route cannot reach any tray path');
    const shortRequest=held(port,{});
    await waitFor(()=>one.listener.inFlight()===1);
    const closing=one.listener.close();
    closing.catch(()=>{});
    await waitFor(()=>closeCalls.length>0);
    assert.deepEqual(one.events,['retire'],'the route is retired before the store closes');
    assert.equal(closeCalls[0].inFlight,1,'the admitted request was still running when retirement began');
    assert.deepEqual(closeCalls[0].call.handle,route.handle);
    // Fenced: no new work, by refused connection or an explicit refusal.
    const late=await reach(port,{'faravan-proof':proofFor('GET',publicOrigin+path)},{target:path}).catch(error=>({status:0,error}));
    assert.ok(late.status===0||late.status===503,'new admission is refused: '+late.status);
    assert.equal(one.events.some(event=>event.startsWith('stores-closed')),false,'the store waits for admitted work');
    shortRequest.finish();
    assert.ok((await shortRequest.response)<500,'the admitted request was drained, not cut');
    await assert.rejects(closing,{code:'synthetic_cleanup'});
    assert.deepEqual(one.events,['retire','stores-closed with 0 in flight'],'drained, never terminated');
    // Unconfirmed cleanup keeps the exact operation and handle, and the route's rules are untouched.
    assert.deepEqual(one.hosting.read().handle,route.handle);
    assert.equal(one.hosting.read().routeOperationId,route.operationId);
    assert.deepEqual(routes,rules,'nothing was removed');

    // Round 2: reopen from the same saved owner state, with a request that never ends.
    refuse=false;
    const two=open({drainMs:150});
    assert.deepEqual(two.hosting.read().handle,route.handle,'the saved owner state names the same route');
    const again=await two.listener.start();
    assert.equal(again.target,target,'the member listener keeps its loopback target across a restart');
    const stuck=held(again.port,{});
    await waitFor(()=>two.listener.inFlight()===1);
    await two.listener.close();
    await assert.rejects(stuck.response,'the stuck request is terminated before the store closes');
    assert.deepEqual(two.events,['retire','terminate','stores-closed with 0 in flight']);
    const closed=two.retired();
    assert.equal(closed.cleanup.state,'confirmed');
    assert.equal(closed.operationId,route.operationId);
    for(const {call} of closeCalls){assert.deepEqual(call.handle,route.handle);assert.equal(call.mode,'remove');}
    assert.equal(two.hosting.read().handle,undefined);
    // Only the exact route went; the foreign rule and its listener are untouched, and our port no longer answers.
    assert.deepEqual([...routes.keys()],['foreign-route']);
    assert.equal((await send('127.0.0.1:'+sentinel.address().port,{path:'/'})).bytes.toString(),'foreign');
    await assert.rejects(reach(again.port,{},{target:path}),'the member listener released its port');
  });
});
