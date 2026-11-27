import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../lib/protocol/index.mjs';
import {HOST_CAPABILITIES} from '../lib/v1/versions.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

for(const available of [true,false])test('borrower app reads live relay availability '+available,{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Inspect parser',harness:'codex'}});
  const base=f.override;
  f.override=async ctx=>{
    if(ctx.route==='/jobs/'+jobDigest.slice(7)+'/transcript') {
      const bytes=Buffer.from(p.canonicalize({job_digest:jobDigest,attempt:available?'33333333-3333-4333-8333-333333333333':null,seq:available?1:0,at:available?'2026-10-20T17:00:00Z':null,text:available?'An activity entry\n':'',truncated:false,available}));
      ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
    }
    return base(ctx);
  };
  const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id);
  assert.equal(view.live,available);assert.equal(view.available,available);
  if(available){assert.equal(view.text,'An activity entry\n');assert.equal(view.unavailable,undefined);}
  else assert.equal(view.unavailable,'lender_version');
});

test('borrower app identifies an older host without claiming a lender failed to report',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  f.hostCapabilities={capabilities:HOST_CAPABILITIES.filter(capability=>capability!=='transcript_relay_v1')};
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Inspect parser',harness:'codex'}});
  const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/transcript?circle='+circle.id);
  assert.equal(view.unavailable,'host_version');assert.equal(view.live,false);
});
