import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../lib/protocol/index.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

// Circle job history while the incumbent host is unreachable (owner-offline topology), in real apps over a real
// signed-roster host and a real member store served by the lender (loopback only, no provider, no execution):
//  - the reader lists the designated jobs the member store holds, with its own signed request, so the store decides
//    what this reader may see;
//  - the answer is marked partial, and jobs only the incumbent holds stay visible only as saved rows;
//  - a member store that refuses the reader (here: a reader the signed roster removed) is no fallback, and an ordinary
//    list keeps the incumbent-only answer.

const nowSeconds=()=>Math.floor(Date.now()/1000);
const source='https://github.com/example/app.git@'+'a'.repeat(40);

test('an unreachable incumbent: circle history comes from the serving member store, signed by the reader, and is marked partial',{timeout:240000},async t=>{
  const f=await appFixture(t);
  const {owner,declining,lender,circle,incumbent}=await f.realConnect({lenderOptions:{}});
  const id=circle.id,lenderId=lender.app.device.keyId,decliningId=declining.app.device.keyId;
  const memberOrigin='http://127.0.0.1:'+(await lender.app.memberListener.start()).port;
  // Record every request the member listener receives and its answer.
  const seen=[],server=lender.app.memberListener.server,original=server.listeners('request');
  server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const url=new URL(req.url,'http://member');
    const proof=req.headers['faravan-proof']?JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload:null;
    const row={method:req.method,path:url.pathname,key:proof?.key_id??null,target:proof?.target??null,epoch:proof?.roster_epoch??null};
    seen.push(row);res.once('finish',()=>{row.status=res.statusCode;});
    for(const listener of original)listener.call(server,req,res);
  });

  await owner.app.device.setMemberOrigin(id,lenderId,memberOrigin);
  await declining.app.device.refreshRoster(id);await lender.app.device.refreshRoster(id);
  assert.equal(p.findMember((await declining.app.device.rosterCache(id).get()).current.payload,lenderId).origin,memberOrigin);

  // The declining peer sends one designated job (kept at the lender's store) and one ordinary job (kept at the incumbent).
  const decliningOps=createJobOperations({device:declining.app.device,clock:nowSeconds});
  const designated=(await decliningOps.submit({circle:id,prompt:'Designated',git:source,harness:'claude-code',
    send_anyway:true,designated_member:lenderId})).jobDigest;
  const ordinary=(await decliningOps.submit({circle:id,prompt:'Ordinary',git:source,harness:'claude-code',send_anyway:true})).jobDigest;

  // With the incumbent up, the selected-circle read is complete and is saved (it holds the ordinary job).
  const selected=()=>api(declining.app,'/api/jobs?circle='+id+'&coverage=1');
  const live=await selected();
  assert.deepEqual(live.circleCoverage,[{circleId:id,state:'verified'}]);
  assert.ok(live.items.some(row=>row.job_digest===ordinary));
  const history=()=>api(declining.app,'/api/jobs',{headers:{'x-faravan-job-history':'1'}});
  const liveHistory=await history();
  assert.equal(liveHistory.circleCoverage.find(row=>row.circleId===id).state,'verified');
  assert.equal(liveHistory.items.some(row=>row.job_digest===designated),false,'the incumbent does not hold the designated job');

  incumbent.down();
  const memberRequestsBefore=seen.length;

  // Operations: the member store answers for the jobs designated to it; the ordinary job cannot be supplied.
  const answer=await decliningOps.listWithCoverage({circle:id},{memberFallback:true});
  assert.deepEqual(answer.coverage,{state:'partial',reason:'incumbent_unreachable',members:[{keyId:lenderId,state:'listed'}]});
  assert.deepEqual(answer.items.map(row=>row.job_digest),[designated]);
  const lists=seen.slice(memberRequestsBefore).filter(row=>row.method==='GET'&&row.path==='/v1/circles/'+id+'/jobs');
  assert.ok(lists.length>0);
  for(const row of lists) {
    assert.equal(row.key,decliningId,'each list is signed by the reading member');
    assert.equal(row.status,200);
    assert.ok(row.target.startsWith(memberOrigin+'/v1/circles/'+id+'/jobs'),'at the origin the accepted signed roster records');
  }
  // An ordinary list still reads only the incumbent, and fails as before.
  await assert.rejects(()=>decliningOps.list({circle:id}),error=>error.code==='circle_unreachable'||error.code==='network_error');

  // Selected circle: live member rows, the saved ordinary job marked saved, and partial coverage.
  const partial=await selected();
  const [coverage]=partial.circleCoverage;
  assert.equal(coverage.state,'partial');
  assert.equal(coverage.reason,'unreachable');
  assert.deepEqual(coverage.members,[{keyId:lenderId,state:'listed'}]);
  const byDigest=new Map(partial.items.map(row=>[row.job_digest,row]));
  assert.equal(byDigest.get(designated)?.savedAt,undefined,'the member store answered for the designated job now');
  assert.equal(byDigest.get(ordinary)?.savedReason,'unreachable','the incumbent-only job is only a saved row');
  assert.equal(typeof byDigest.get(ordinary)?.savedAt,'string');
  assert.equal(coverage.cachedRows,partial.items.filter(row=>row.savedAt).length);
  assert.equal(coverage.liveRows,partial.items.length-coverage.cachedRows);

  // Job history across circles: the declining peer's own jobs, its designated one live and the ordinary one saved.
  const offline=await history();
  const historyCoverage=offline.circleCoverage.find(row=>row.circleId===id);
  assert.equal(historyCoverage.state,'partial');
  assert.deepEqual(offline.uncheckedCircles.filter(row=>row.id===id),[{id,reason:'partial'}]);
  const historyRows=new Map(offline.items.filter(row=>row.circle.id===id).map(row=>[row.job_digest,row]));
  assert.equal(historyRows.get(designated)?.role,'sent');
  assert.equal(historyRows.get(designated)?.savedAt,undefined);
  assert.equal(historyRows.get(ordinary)?.savedReason,'unreachable');
  assert.equal(historyCoverage.liveRows,1);
  assert.equal(historyCoverage.cachedRows,1);

  // A partial answer never replaced the saved full list: the next read still has the saved ordinary job.
  assert.ok((await selected()).items.some(row=>row.job_digest===ordinary&&row.savedAt));

  // The incumbent returns: the list is complete again and comes from the incumbent alone.
  incumbent.up();
  const back=await decliningOps.listWithCoverage({circle:id},{memberFallback:true});
  assert.deepEqual(back.coverage,{state:'complete'});
  assert.ok(back.items.some(row=>row.job_digest===ordinary));
  assert.equal(back.items.some(row=>row.job_digest===designated),false,'the incumbent does not hold the designated job');

  // A member store that refuses the reader is no fallback. The owner removes the declining peer, the serving member
  // installs that signed roster, and the incumbent goes away before the peer hears of it: its old roster still names
  // the member origin, but the store refuses its signed request, so the read stays the ordinary unavailable one.
  await owner.app.device.removeMember(id,decliningId);
  await lender.app.device.refreshRoster(id);
  incumbent.down();
  const deniedBefore=seen.length;
  await assert.rejects(()=>decliningOps.listWithCoverage({circle:id},{memberFallback:true}),
    error=>error.code==='circle_unreachable'||error.code==='network_error','the incumbent failure stands');
  const refusals=seen.slice(deniedBefore).filter(row=>row.key===decliningId&&row.path==='/v1/circles/'+id+'/jobs');
  assert.ok(refusals.length>0&&refusals.every(row=>row.status===403),JSON.stringify(refusals));
  const denied=await selected();
  assert.equal(denied.circleCoverage[0].state,'unavailable');
  assert.equal(denied.items.some(row=>!row.savedAt),false,'nothing is shown as live');
});
