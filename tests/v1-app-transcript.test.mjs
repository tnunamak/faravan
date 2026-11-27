import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-lifecycle-fixture.mjs';

const data='A'.repeat(212*1024);
const normal=Array.from({length:29},(_,i)=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`entry ${i}: `+'x'.repeat(2000)}]}})+'\n').join('');
const image=JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:[{type:'image',source:{type:'base64',media_type:'image/png',data}}]}]}})+'\n';

test('live and stored app transcripts preserve safe lines and withhold oversized media before framing metadata', {timeout:60000}, async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),start=backend.start.bind(backend);
  let raw;
  backend.start=async(handle,opts={})=>{
    let emitted=false;
    await start(handle,{...opts,onLog:event=>{
      emitted=true;
      const extra=normal+image;
      for(let i=0;i<extra.length;i+=7000)opts.onLog?.({stream:'stdout',chunk:Buffer.from(extra.slice(i,i+7000))});
      opts.onLog?.(event);
    }});
    if(emitted)raw=handle._lastExecStdout=normal+image+handle._lastExecStdout;
  };
  const {owner,lender,circle}=await f.connect({backend});
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0]);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(jobDigest).state==='result-accepted','signed result',30000);
  const route='/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id;
  for(const [app,live] of [[lender.app,false],[owner.app,false]]) {
    const view=await api(app,route),lines=view.text.trimEnd().split('\n');
    assert.equal(view.live,live);
    assert.equal(lines.length,33);
    assert.equal(JSON.parse(lines[32]).type,'faravan.continuation');
    assert.equal(JSON.parse(lines[32]).handoff.trust,'untrusted');
    assert.equal(JSON.parse(lines[31]).type,'faravan.job_context');
    assert.equal(JSON.parse(lines[31]).job_framing_version,1);
    assert.equal(view.text.slice(0,normal.length),normal);
    assert.deepEqual(JSON.parse(lines[29]).message.content[0].content[0],{type:'image',omitted:true,media_type:'image/png',bytes:data.length});
  }
  const result=f.jobs.get(jobDigest).result;
  const signed=f.artifacts.get(result.payload.transcript.digest);
  assert.ok(raw.includes(data),'the provider emitted oversized media');
  assert.equal(signed.toString().includes(data),false,'oversized provider records stay local');
  assert.equal(signed.subarray(0,Buffer.byteLength(normal)).toString(),normal,'safe native records stay unchanged');
  const [context,handoff]=signed.toString().trim().split('\n').slice(-2).map(line=>JSON.parse(line));
  assert.equal(handoff.handoff.scan.status,'passed','only bounded selected context is scanned; omitted media is not context');
  assert.equal(handoff.type,'faravan.continuation');
  assert.equal(handoff.binding.job_digest,jobDigest);
  assert.equal(handoff.binding.circle,circle.id);
  assert.equal(typeof handoff.signature,'string');
  assert.equal(context.type,'faravan.job_context');
  assert.equal(context.job_framing_version,1);
  assert.ok(context.workspace_path.endsWith('/repo'));
});
