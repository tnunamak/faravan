import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, readdir, stat, writeFile, readlink, symlink, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { runMcpServer } from '../lib/v1/mcp.mjs';
import { join } from 'node:path';
import { fixture, parseOne } from './helpers/v1-journey.mjs';
import { problemForError, statusLabel, statusMessage, runV1Command, createJobOperations, joinMessage } from '../lib/v1/cli.mjs';
import { canonicalize, signEnvelope, digest } from '../lib/protocol/index.mjs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { openDevice } from '../lib/v1/device.mjs';
import { createClient } from '../lib/v1/client.mjs';
import * as protocol from '../lib/protocol/index.mjs';
import { forgeries } from './helpers/v1-short-invite.mjs';


test('join formatter distinguishes terminal membership and unknown approval policy',()=>{
  for(const approval of ['each','automatic','unknown',undefined]) {
    for(const [state,cause] of [['expired','expired'],['rejected','declined']]) {
      const text=joinMessage({name:'Friends',origin:'https://example.test',enrollment:{state},joinInfo:{approval,ownerName:'Ana'}});
      assert.ok(text.includes(cause),state+' / '+approval);
      assert.match(text,/Ask for a new invitation, then run faravan circle join/);
      assert.doesNotMatch(text,/Waiting for|approves it when/);
    }
  }
  for(const approval of ['unknown','unexpected',undefined]) {
    const text=joinMessage({name:'Friends',enrollment:{state:'pending'},joinInfo:{approval}});
    assert.match(text,/approval policy is unknown/);
    assert.match(text,/Check the circle status or ask the owner/);
    assert.doesNotMatch(text,/approves it when it is online/);
  }
});

test('status formatter follows validated phases rather than claimed or finished raw shortcuts',async()=>{
  const {adaptLegacyJob}=await import('../lib/v1/state-projection.mjs');
  const at='2026-10-20T00:00:00Z',job_digest='sha256:'+'a'.repeat(64);
  const cases=[
    [{state:'claimed',approval:'pending'},'Waiting for an answer.'],
    [{state:'claimed',approval:'approved'},'Approved.'],
    [{state:'claimed'},'Waiting.'],
    [{state:'starting',approval:'approved'},'Starting.'],
    [{state:'running',current_attempt:{execution_observed_at:at}},'Working.'],
    [{state:'finished'},'Ready to review.'],
    [{state:'claimed',approval:'pending',current_attempt:{execution_observed_at:at}},'Status unavailable.'],
    [{state:'cancelled',current_attempt:null},'Cancelled. Nothing ran.'],
  ];
  for(const [fields,prefix] of cases) {
    const view={job_digest,...fields};
    assert.ok(statusMessage(view).startsWith(prefix),JSON.stringify(fields));
    const projected={job_digest,state:'claimed',jobProjection:adaptLegacyJob(view)};
    assert.equal(statusMessage(projected),statusMessage(view),'validated projection wins over raw state');
  }
  for(const fields of [{state:'claimed',approval:'approved'},{state:'finished'}])
    assert.equal(statusMessage({job_digest,...fields,jobProjection:{phase:'running'}}),'Status unavailable. Check again shortly.');
});

const git='https://example.test/synthetic.git@'+'a'.repeat(40);
test('owner-store job JSON names the owner as its home',async t=>{
  const f=await fixture(t),circle=await create(f),digest=await submit(f,circle);
  assert.deepEqual(parseOne(await f.cli(['job','status',digest,'--circle',circle,'--json'])).jobHome,{origin:f.origin,ownerOrigin:f.origin});
});
test('circle join copy follows verified membership and retries an unknown saved intent',()=>{
  const joined={id:'circle',name:'Friends',origin:'https://example.test'};
  const unknown={...joined,joinIntent:{outcome:'unknown'}};
  assert.match(joinMessage(unknown),/Could not reach the circle host.*retry with the same invitation/);
  // A finished join clears its saved intent, so these cases carry none.
  assert.match(joinMessage({...joined,enrollment:{state:'approved'},rosterMembershipVerified:false}),/Membership is not confirmed yet/);
  assert.equal(joinMessage({...joined,enrollment:{state:'approved'},rosterMembershipVerified:true}),'Circle joined: Friends.');
});
async function create(f,name='owner') {
  await f.provisionFromHome(name);
  const result=await f.cli(['circle','create',f.origin,'--name','Synthetic circle'],name);
  assert.equal(result.code,0,result.stderr);
  return [...f.circles.keys()].at(-1);
}
async function submit(f,circle,extra=[]) {
  return parseOne(await f.cli(['job','submit','--yes','--git',git,'--prompt','Synthetic offline test',
    '--circle',circle,'--json',...extra])).jobDigest;
}


test('shared ops and legacy CLI carry requested model and effort into the signed job',async t=>{
  const f=await fixture(t),circle=await create(f),ops=createJobOperations({home:await f.home()});
  const {runOp}=await import('../lib/v1/ops/execute.mjs');
  const context={confirmed:true,rest:async(method,path,request)=>{
    if(path==='/api/circles')return [{id:circle,name:'Synthetic circle',origin:f.origin,enrollment:{state:'approved'},rosterMembershipVerified:true}];
    assert.equal(method,'POST');assert.equal(path,'/api/jobs');
    const payload=request.body;
    return ops.submit({...payload,git:payload.git.url+'@'+payload.git.commit});
  }};
  const base={circle,prompt:'Requested reasoning',git:{url:'https://example.test/synthetic.git',commit:'a'.repeat(40)},
    result:{kind:'message'},model:'synthetic-model'};
  const sent=await runOp('jobs.submit',{...base,budget_v1:{effort:'high'}},context);
  const shared=f.jobs.get(sent.jobDigest).job;
  assert.deepEqual(shared.payload.requirements.model,{any_of:['synthetic-model']});
  assert.deepEqual(shared.payload.budget_v1,{effort:'high'});
  assert.ok(shared.payload.requirements.capabilities.includes('budget_v1'));
  assert.equal(digest(shared.payload),sent.jobDigest);
  const legacy=await submit(f,circle,['--model','synthetic-model','--effort','high']);
  const signed=f.jobs.get(legacy).job;
  assert.deepEqual(signed.payload.requirements.model,{any_of:['synthetic-model']});
  assert.deepEqual(signed.payload.budget_v1,{effort:'high'});
  assert.equal(digest(signed.payload),legacy);
  const omitted=await runOp('jobs.submit',base,context);
  assert.equal(f.jobs.get(omitted.jobDigest).job.payload.budget_v1,undefined);
  const plain=await submit(f,circle);
  assert.equal(f.jobs.get(plain).job.payload.budget_v1,undefined);
  const withCap=await submit(f,circle,['--budget-v1','{"max_list_usd":10,"effort":"high"}','--effort','high']);
  assert.deepEqual(f.jobs.get(withCap).job.payload.budget_v1,{max_list_usd:10,effort:'high'});
});

test('legacy requested effort refuses invalid and conflicting inputs before network',async t=>{
  const f=await fixture(t),circle=await create(f),before=f.requests.length;
  for(const extra of [
    ['--effort','ultra'],['--effort','null'],
    ['--budget-v1','{"effort":"low"}','--effort','high'],
    ['--budget-v1','null'],['--budget-v1','{}'],['--budget-v1','not-json'],
    ['--budget-v1','{"effort":null}'],['--budget-v1','{"max_list_usd":0}','--effort','high'],
    ['--budget-v1','{"max_list_usd":1.5}'],['--budget-v1','{"max_list_usd":100001}'],
    ['--budget-v1','{"extra":true,"effort":"high"}'],
  ]) {
    const result=await f.cli(['job','submit','--yes','--git',git,'--prompt','Refuse invalid reasoning','--circle',circle,'--json',...extra]);
    assert.equal(result.code,2,result.stdout+result.stderr);
    assert.equal(JSON.parse(result.stdout).code,'invalid_request');
  }
  assert.equal(f.requests.length,before);
  assert.equal(f.jobs.size,0);
});

test('submit expands the friendly agent into signed choices and preserves draft replay',async t=>{
  const f=await fixture(t),circle=await create(f);
  const ops=createJobOperations({home:await f.home()});
  const request={git,prompt:'Choose Claude Code',circle,harness:'claude-code',draftId:'agent-choice-0001'};
  const first=await ops.submit(request),job=f.jobs.get(first.jobDigest).job;
  assert.deepEqual(job.payload.requirements.harness,['claude-code-subscription','claude-code-api-key']);
  assert.equal(digest(job.payload),first.jobDigest);
  const submissions=()=>f.requests.filter(r=>r.method==='POST'&&r.route==='/jobs').length;
  const signed=canonicalize(job),before=submissions(),replay=await ops.submit(request);
  assert.equal(replay.jobDigest,first.jobDigest);
  assert.equal(replay.operationKey,first.operationKey);
  assert.equal(replay.replayed,true);
  assert.equal(canonicalize(f.jobs.get(first.jobDigest).job),signed);
  assert.equal(submissions(),before,'draft replay does not resend');
});

test('submit keeps canonical agent choices singular and absent agent unrestricted',async t=>{
  const f=await fixture(t),circle=await create(f);
  for(const name of ['claude-code-subscription','claude-code-api-key','codex','gemini','opencode','gh-cli']) {
    const id=await submit(f,circle,['--harness',name]);
    assert.deepEqual(f.jobs.get(id).job.payload.requirements.harness,[name]);
  }
  const id=await submit(f,circle);
  assert.equal(Object.hasOwn(f.jobs.get(id).job.payload.requirements,'harness'),false);
});

test('unknown agents fail with valid choices before network or source packaging',async t=>{
  const f=await fixture(t),circle=await create(f),before=f.requests.length;
  for(const sourceArgs of [['--git',git],['--source',join(f.root,'does-not-exist')]]) {
    const result=await f.cli(['job','submit',...sourceArgs,'--prompt','Test','--circle',circle,
      '--harness','not-an-agent','--json']);
    assert.equal(result.code,2,result.stderr+result.stdout);
    const error=JSON.parse(result.stdout);
    assert.equal(error.code,'invalid_request');
    assert.match(error.message,/Valid agents:/);
    for(const name of ['claude-code','claude-code-subscription','claude-code-api-key'])
      assert.ok(error.message.includes(name),name);
  }
  assert.equal(f.requests.length,before,'invalid agents make no requests');
  assert.equal(f.jobs.size,0);
});

test('agent help explains friendly and canonical choices for run and submit',()=>{
  for(const path of [['run'],['job','submit']]) {
    const text=helpFor(path);
    assert.match(text,/claude-code/);
    assert.match(text,/claude-code-subscription/);
    assert.match(text,/claude-code-api-key/);
    assert.match(text,/lender chooses/i);
    assert.doesNotMatch(text,/adapter/i);
  }
});

test('borrowers can fix a check command in the signed request without running it locally', async t => {
  const f=await fixture(t), circle=await create(f);
  const first=await submit(f,circle,['--verify-cmd','npm test']);
  const payload=f.jobs.get(first).job.payload;
  assert.deepEqual(payload.verify,{cmd:'npm test'});
  assert.ok(payload.requirements.capabilities.includes('verify_v1'));
  const second=await submit(f,circle,['--verify-cmd','node --test']);
  assert.notEqual(first,second,'different check commands are different signed requests');
  const before=f.requests.length;
  const bad=await f.cli(['job','submit','--yes','--git',git,'--prompt','Test','--circle',circle,'--verify-cmd','   ','--json']);
  assert.equal(bad.code,2);
  assert.equal(f.requests.length,before,'invalid checks are rejected before any network request');
  const plain=await submit(f,circle);
  assert.equal(f.jobs.get(plain).job.payload.verify,undefined);
  assert.deepEqual(f.jobs.get(plain).job.payload.requirements.capabilities,['filtered_git_v1']);
  const ops=createJobOperations({home:await f.home()});
  const request={git,prompt:'Check this',circle,draftId:'check-command-0001',verify:{cmd:'npm test'}};
  const sent=await ops.submit(request), replay=await ops.submit(request);
  assert.equal(replay.jobDigest,sent.jobDigest);
  await assert.rejects(ops.submit({...request,verify:{cmd:'node --test'}}),{code:'draft_changed'});
  const changed=await ops.submit({...request,draftId:'check-command-0002',verify:{cmd:'node --test'}});
  assert.notEqual(changed.jobDigest,sent.jobDigest,'a changed check is never a replay of the earlier command');
  for(const verify of [null,false,{},[],{cmd:''},{cmd:7},{cmd:'x',extra:true},{cmd:'x'.repeat(4097)},{cmd:'\0'}])
    await assert.rejects(ops.submit({...request,verify}),{code:'invalid_request'});
  const promptFile=join(f.root,'check-prompt.txt');
  await writeFile(promptFile,'Check the source');
  for(const field of ['verify','verify-cmd']) {
    const input={git,circle,promptFile,[field]:field==='verify'?{cmd:'npm test'}:'npm test'};
    const pending=ops.submit(input);
    if(field==='verify')input.verify.cmd='echo changed after submit';
    else input[field]='echo changed after submit';
    const submitted=await pending;
    assert.deepEqual(f.jobs.get(submitted.jobDigest).job.payload.verify,{cmd:'npm test'},'the check is captured before reading the prompt file');
  }
});

test('first use persists a private device and My devices circle in isolated home',async t=>{
  const f=await fixture(t), first=await f.cli(['circle','list']);
  assert.equal(first.code,0,first.stderr);assert.match(first.stdout+first.stderr,/My devices/);
  assert.equal(f.requests.length,0,'offline first use must not send requests');
  const state=JSON.parse(await readFile(join(await f.home(),'v1','state.json'),'utf8'));
  assert.equal(state.circles.length,1);assert.equal(state.circles[0].origin,null);
  const key=join(await f.home(),'v1','device.pem'), bytes=await readFile(key);
  assert.equal((await stat(key)).mode&0o777,0o600);
  const again=await f.cli(['circle','list']);assert.equal(again.code,0,again.stderr);
  assert.deepEqual(await readFile(key),bytes);
});

test('unprovisioned circle fails closed rather than enrolling an arbitrary root',async t=>{
  const f=await fixture(t),result=await f.cli(['circle','create',f.origin,'--name','Unprovisioned','--json']);
  assert.equal(result.code,3);assert.equal(JSON.parse(result.stdout).code,'circle_not_provisioned');assert.equal(f.circles.size,0);
  assert.equal(result.stdout.trim().split('\n').length,1);assert.match(result.stderr,/provisioning\.json/);
  const home=await f.home(),state=JSON.parse(await readFile(join(home,'v1','state.json'),'utf8'));
  const local=state.circles.find(c=>c.name==='Unprovisioned');assert.ok(local);
  const file=join(home,'v1','circles',local.id,'provisioning.json'),raw=await readFile(file,'utf8'),provisioning=JSON.parse(raw);
  assert.deepEqual(Object.keys(provisioning).sort(),['circle_id','origin','root_fingerprint','roster']);
  assert.equal(provisioning.circle_id,local.id);assert.equal(provisioning.root_fingerprint,local.pinnedRootFingerprint);
  assert.equal(provisioning.origin,f.origin);assert.equal(provisioning.roster.payload.epoch,1);
  assert.doesNotMatch(raw,/PRIVATE KEY|private_key|private_seed/);assert.equal((await stat(file)).mode&0o777,0o600);
  const key=join(home,'v1','roots',local.id+'.pem'),rootBefore=await readFile(key);
  await f.provisionFromHome();
  const retried=parseOne(await f.cli(['circle','create',f.origin,'--name','Unprovisioned','--json']));
  assert.equal(retried.id,local.id);assert.deepEqual(await readFile(key),rootBefore);
  assert.equal(f.circles.size,1);assert.equal(f.circles.get(local.id).roster.payload.root_public_key,provisioning.roster.payload.root_public_key);
});

const SHORT=/http:\/\/127\.0\.0\.1:\d+\/i\/[a-z2-7]{10}#[A-Za-z0-9_-]{43}/, LONG=/http:\/\/127\.0\.0\.1:\d+\/join#invite=[A-Za-z0-9_-]+/;
test('circle create, invite, join, approve advances signed roster and enrolls only invited device',async t=>{
  const f=await fixture(t), circle=await create(f), c=f.circles.get(circle);
  assert.equal(c.roster.payload.epoch,1);assert.equal(c.roster.payload.members.length,1);
  const root=join(await f.home(),'v1','roots',circle+'.pem');assert.equal((await stat(root)).mode&0o777,0o600);
  const invitation=await f.cli(['circle','invite','--circle',circle]);
  assert.equal(invitation.code,0,invitation.stderr);
  // The default invitation is the short link: origin, /i/<code>, and the seed only in the fragment.
  const link=(invitation.stdout+invitation.stderr).match(SHORT)?.[0];
  assert.ok(link,'explicit invite command yields a short fragment-only invitation');
  assert.ok(link.length<100);assert.equal(invitation.stdout.trim(),link,'the link is the only output');assert.equal(invitation.stderr,'');
  const seed=link.slice(link.indexOf('#')+1);
  const joined=await f.cli(['circle','join',link,'--name','Guest laptop'],'guest');assert.equal(joined.code,0,joined.stderr);
  assert.equal(c.roster.payload.members.length,1,'enrollment alone must not grant membership');
  // The short link took one public lookup and nothing the server saw holds the seed.
  assert.equal(f.rawRequests.filter(r=>r.url.startsWith('/v1/invites/')).length,1);
  assert.ok(!JSON.stringify(f.rawRequests).includes(seed),'the seed never reaches the server');
  assert.ok(f.rawRequests.every(r=>!r.url.includes('#')));
  const pending=c.enrollments[0],proof=pending.enrollment_proof;
  pending.enrollment_proof={...proof,signature:{...proof.signature,value:'A'.repeat(86)}};
  const refused=await f.cli(['circle','approve','--circle',circle,'--json']);
  assert.equal(refused.code,0,refused.stderr);assert.equal(JSON.parse(refused.stdout).approved.length,0);
  assert.equal(c.roster.payload.epoch,1,'invalid invite proof must not advance membership');
  pending.enrollment_proof=proof;
  const approved=await f.cli(['circle','approve','--circle',circle]);assert.equal(approved.code,0,approved.stderr);
  assert.match(approved.stdout,/Guest laptop\s+sha256:[0-9a-f]{64}/,'approve names the device and shows its key fingerprint');
  assert.equal(c.roster.payload.epoch,2);assert.equal(c.roster.payload.members.length,2);
  const listed=await f.cli(['circle','list'],'guest');assert.equal(listed.code,0,listed.stderr);
  assert.ok(f.requests.some(r=>r.route==='/enrollments'&&r.method==='POST'));
});

test('circle invite --json reports the short link; join accepts the long link and the bare invitation text too',async t=>{
  const f=await fixture(t), circle=await create(f);
  const made=parseOne(await f.cli(['circle','invite','--circle',circle,'--json']));
  assert.match(made.invite,SHORT);assert.equal(made.note,undefined);
  const stored=[...f.publications.values()].at(-1);
  // The long form of the same invitation is what the short link resolves to; the joiner may use either, once.
  const long=protocol.encodeInviteLink(stored.envelope,protocol.decodeShortLink(made.invite).seed);
  assert.match(long,LONG);
  assert.equal((await f.cli(['circle','join',long,'--name','Long link'],'guest-long')).code,0);
  assert.equal(f.rawRequests.filter(r=>r.url.startsWith('/v1/invites/')).length,0,'a long link needs no lookup');
  const second=parseOne(await f.cli(['circle','invite','--circle',circle,'--json'])).invite;
  const secondStored=[...f.publications.values()].at(-1);
  const blob=protocol.encodeInviteLink(secondStored.envelope,protocol.decodeShortLink(second).seed).split('#invite=')[1];
  assert.equal((await f.cli(['circle','join',blob,'--name','Bare blob'],'guest-blob')).code,0);
  const third=parseOne(await f.cli(['circle','invite','--circle',circle,'--json'])).invite;
  const wrapped='faravan://join?link='+encodeURIComponent(third);
  assert.equal((await f.cli(['circle','join',wrapped,'--name','Wrapped'],'guest-wrapped')).code,0);
  for(const junk of ['not a link','https://queue.example/other','faravan://join']) {
    const r=await f.cli(['circle','join',junk],'guest-junk');assert.equal(r.code,1);assert.match(r.stderr,/not valid/);
  }
});

test('faravan name sets the name that circle invite signs as owner_name',async t=>{
  const f=await fixture(t), circle=await create(f);
  const shown=await f.cli(['name']);assert.equal(shown.code,0,shown.stderr);
  assert.match(shown.stdout,/^Invitations say: .+ invited you\.$/m);
  parseOne(await f.cli(['circle','invite','--circle',circle,'--json']));
  assert.equal([...f.publications.values()].at(-1).envelope.payload.owner_name,parseOne(await f.cli(['name','--json'])).name);
  const set=await f.cli(['name','Rowan Vale']);assert.equal(set.code,0,set.stderr);
  assert.equal(set.stdout,'Saved. New invitations say: Rowan Vale invited you.\n');
  parseOne(await f.cli(['circle','invite','--circle',circle,'--json']));
  assert.equal([...f.publications.values()].at(-1).envelope.payload.owner_name,'Rowan Vale');
  assert.equal((await f.cli(['name','Rowan','Vale'])).code,2,'an unquoted name with spaces is a usage error');
});

test('circle invite falls back to the long link with a one-line note when the server cannot publish',async t=>{
  const f=await fixture(t), circle=await create(f);
  f.refuseShortInvites=true;
  const human=await f.cli(['circle','invite','--circle',circle]);
  assert.equal(human.code,0,human.stderr);
  assert.match(human.stdout,LONG);assert.doesNotMatch(human.stdout,SHORT);
  const lines=human.stdout.trim().split('\n');
  assert.equal(lines.length,2);assert.match(lines[1],/could not publish a short link, so this is the long link/);
  const json=parseOne(await f.cli(['circle','invite','--circle',circle,'--json']));
  assert.match(json.invite,LONG);assert.match(json.note,/long link/);
  assert.equal(f.publications.size,0);
  const joined=await f.cli(['circle','join',lines[0],'--name','Guest laptop'],'guest');assert.equal(joined.code,0,joined.stderr);
});

test('attack regression: circle join refuses a short link whose invitation names a root the owner did not sign with',async t=>{
  const f=await fixture(t), circle=await create(f);
  const link=(await f.cli(['circle','invite','--circle',circle])).stdout.trim();
  const {code}=protocol.decodeShortLink(link);
  const real=structuredClone(f.publications.get(code));
  for(const {label,publication} of forgeries(real)) {
    f.publications.set(code,publication);
    const before=f.requests.length;
    const refused=await f.cli(['circle','join',link,'--name','Guest laptop'],'guest');
    assert.equal(refused.code,1,label);assert.match(refused.stderr,/could not be verified, so it was not used/,label);
    assert.equal(refused.stdout,'',label);
    assert.equal(f.requests.slice(before).length,0,label+': no signed request was made');
    assert.deepEqual(f.circles.get(circle).enrollments,[],label+': nothing was enrolled');
    const state=await readFile(join(await f.home('guest'),'v1','state.json'),'utf8').catch(()=>'{"circles":[]}');
    assert.ok(!state.includes(publication.envelope.payload.root_fingerprint),label+': the attacker root was never pinned');
  }
  f.publications.set(code,real);
  assert.equal((await f.cli(['circle','join',link,'--name','Guest laptop'],'guest')).code,0,'the honest publication still joins');
});

test('circle join reports a missing or expired short link plainly',async t=>{
  const f=await fixture(t), circle=await create(f);
  const link=(await f.cli(['circle','invite','--circle',circle])).stdout.trim();
  const {code}=protocol.decodeShortLink(link);
  const gone=await f.cli(['circle','join',link.replace(code,'abcde23456'),'--name','G'],'guest');
  assert.equal(gone.code,3);assert.match(gone.stderr,/invitation was not found/);
  const real=f.publications.get(code);
  f.publications.set(code,{...real,envelope:{...real.envelope,payload:{...real.envelope.payload,expires_at:'2020-01-01T00:00:00Z'}}});
  const expired=await f.cli(['circle','join',link,'--name','G'],'guest');
  assert.notEqual(expired.code,0);assert.equal(expired.stdout,'');assert.match(expired.stderr,/invitation has expired/);
});

test('submit JSON is one immediate value; source packing, status, list and cancel use signed client',async t=>{
  const f=await fixture(t),circle=await create(f),source=join(f.root,'source');await mkdir(source);
  await writeFile(join(source,'README.txt'),'Synthetic source only\n');
  const before=f.requests.length;
  const submitted=parseOne(await f.cli(['job','submit','--yes','--source',source,'--prompt','Offline fixture',
    '--harness','claude-code-subscription','--model','synthetic-model','--egress','provider-only','--circle',circle,'--json']));
  assert.match(submitted.jobDigest,/^sha256:[a-f0-9]{64}$/);
  assert.equal(f.requests.slice(before).filter(r=>r.route.startsWith('/jobs/')).length,0,'submission must not poll');
  const view=f.jobs.get(submitted.jobDigest);assert.equal(view.job.payload.source.kind,'archive');
  assert.deepEqual(view.job.payload.requirements.limit_modes,{wall_seconds:'required',cpu:'required',memory_bytes:'required',disk_bytes:'preferred',output_bytes:'required'});
  assert.equal(f.artifacts.get(view.job.payload.source.artifact.digest).subarray(0,2).toString('hex'),'1f8b');
  const status=parseOne(await f.cli(['job','status',submitted.jobDigest,'--circle',circle,'--json']));
  assert.equal(status.status,'Waiting');
  const human=await f.cli(['job','status',submitted.jobDigest,'--circle',circle]);
  assert.match(human.stdout+human.stderr,/Waiting/);
  const list=parseOne(await f.cli(['job','list','--circle',circle,'--json']));assert.equal(list.length,1);
  const cancelled=await f.cli(['job','cancel',submitted.jobDigest,'--circle',circle]);assert.equal(cancelled.code,0,cancelled.stderr);
  assert.equal(parseOne(await f.cli(['job','status',submitted.jobDigest,'--circle',circle,'--json'])).status,'Cancelled');
});

test('repeated submissions reuse source and prompt artifacts with their stored media types',async t=>{
  const f=await fixture(t),circle=await create(f),source=join(f.root,'repeat-source');await mkdir(source);
  await writeFile(join(source,'source.txt'),'Repeated source\n');
  const args=['job','submit','--yes','--source',source,'--prompt','Repeated prompt','--circle',circle,'--json'];
  const first=parseOne(await f.cli(args));
  const puts=f.requests.filter(r=>r.method==='PUT'&&r.route.startsWith('/artifacts/')).length;
  assert.equal(puts,2);
  // While the first job is unfinished the same command follows it (tests/v1-send-identity); once it has finished,
  // the same command is new work.
  await f.complete(first.jobDigest);
  const before=f.requests.length,second=parseOne(await f.cli(args));
  assert.notEqual(second.jobDigest,first.jobDigest,'a finished job lets the same request start a fresh intent');
  assert.equal(f.jobs.size,2);
  assert.equal(f.requests.filter(r=>r.method==='PUT'&&r.route.startsWith('/artifacts/')).length,puts);
  assert.equal(f.requests.slice(before).filter(r=>r.method==='GET'&&r.route.startsWith('/artifacts/')).length,2);
});

test('closed status vocabulary keeps result verification and stop acknowledgement honest',()=>{
  for(const [state,label] of [['queued','Waiting'],['claimed','Waiting'],['result-accepted','Finished'],
    ['failed','Failed'],['expired','Expired'],['unknown','Status unavailable']]) assert.equal(statusLabel({state}),label);
  assert.equal(statusLabel({state:'claimed',current_attempt:{state:'active',execution_started_at:'2026-10-23T15:52:09Z'}}),'Working');
  assert.equal(statusLabel({state:'claimed',approval:'approved'}),'Approved');
  assert.equal(statusLabel({state:'cancelled',current_attempt:null}),'Cancelled');
  assert.equal(statusLabel({state:'cancelled',current_attempt:{compute_stopped:false}}),'Stopping');
  assert.equal(statusLabel({state:'cancelled',current_attempt:{compute_stopped:true}}),'Cancelled');
});

test('verified result extracts to empty directory; tampering and occupied output fail without overwrite',async t=>{
  const f=await fixture(t),circle=await create(f),id=await submit(f,circle),result=await f.complete(id);
  const out=join(f.root,'result');await mkdir(out);
  const read=await f.cli(['job','result',id,'--circle',circle,'--out',out]);assert.equal(read.code,0,read.stderr);
  assert.equal(await readFile(join(out,'summary.txt'),'utf8'),'Synthetic verified result\n');
  const occupied=await f.cli(['job','result',id,'--circle',circle,'--out',out]);assert.notEqual(occupied.code,0);
  assert.equal(await readFile(join(out,'summary.txt'),'utf8'),'Synthetic verified result\n');
  const corrupt=Buffer.from(f.artifacts.get(result.payload.candidate.digest));corrupt[0]^=1;
  f.artifacts.set(result.payload.candidate.digest,corrupt);
  const refusedOut=join(f.root,'refused');await mkdir(refusedOut);
  const refused=await f.cli(['job','result',id,'--circle',circle,'--out',refusedOut,'--json']);
  assert.notEqual(refused.code,0);assert.deepEqual(await readdir(refusedOut),[]);
  assert.match(JSON.parse(refused.stdout).code,/digest|verification|invalid/);
});

test('CLI maps usage, not found, conflict, retryable and other errors to documented exit codes',async t=>{
  const f=await fixture(t),circle=await create(f),id=await submit(f,circle);
  const usage=await f.cli(['job','submit','--yes','--json']);assert.equal(usage.code,2);assert.ok(JSON.parse(usage.stdout).code);
  for(const [status,code,expected] of [[404,'job_not_found',3],[409,'conflict',4],[503,'unavailable',5]]) {
    f.override=async({res,route})=>{if(!route.startsWith('/jobs/'))return false;
      const body=canonicalize({code,message:code,status,retryable:status===503,outcome:'not_applied'});
      res.writeHead(status,{'content-type':'application/problem+json'});res.end(body);return true;};
    const output=await f.cli(['job','status',id,'--circle',circle,'--json']);assert.equal(output.code,expected,output.stderr+output.stdout);
    const error=JSON.parse(output.stdout);assert.equal(error.code,code);assert.equal(typeof error.message,'string');
  }
  let stdout='',stderr='';
  const code=await runV1Command(['circle','list','--json'],{device:{listCircles(){throw new Error('synthetic failure');}},
    stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});
  assert.equal(code,1);assert.ok(JSON.parse(stdout).code);
});

test('pending submit survives process restart and retries the identical signed intent after lost acknowledgement',async t=>{
  const f=await fixture(t),circle=await create(f);
  const args=['job','submit','--yes','--git',git,'--prompt','Retry exactly once intent','--circle',circle,'--json'];
  f.dropPublishAck=true;
  const failed=await f.cli(args);assert.equal(failed.code,5,failed.stderr+failed.stdout);
  const previous=f.requests.filter(r=>r.route==='/jobs'&&r.method==='POST');
  assert.ok(previous.length>0);assert.equal(f.jobs.size,1);
  f.dropPublishAck=false;
  const submitted=parseOne(await f.cli(args));
  const requests=f.requests.filter(r=>r.route==='/jobs'&&r.method==='POST');
  assert.equal(f.jobs.size,1);assert.equal(submitted.jobDigest,[...f.jobs.keys()][0]);
  assert.ok(requests.every(r=>canonicalize(r.body)===canonicalize(previous[0].body)));
  assert.ok(requests.every(r=>r.proof.payload.idempotency_key===previous[0].proof.payload.idempotency_key));
  assert.equal(new Set(requests.map(r=>r.proof.payload.nonce)).size,requests.length);
});

test('result media type controls patch handling and malformed declared gzip is refused',async t=>{
  const f=await fixture(t),circle=await create(f),patch=Buffer.from('--- a/example.txt\n+++ b/example.txt\n');
  const id=await submit(f,circle);await f.complete(id,'owner',{candidate:patch,candidateMediaType:'text/x-diff'});
  const out=join(f.root,'patch-result');
  const read=await f.cli(['job','result',id,'--circle',circle,'--out',out]);assert.equal(read.code,0,read.stderr);
  assert.deepEqual(await readFile(join(out,'changes.patch')),patch);
  const malformed=await submit(f,circle);await f.complete(malformed,'owner',{candidate:patch,candidateMediaType:'application/gzip'});
  const bad=join(f.root,'invalid-gzip');await mkdir(bad);
  const result=await f.cli(['job','result',malformed,'--circle',circle,'--out',bad,'--json']);
  assert.notEqual(result.code,0);assert.deepEqual(await readdir(bad),[]);
});

test('owner refreshes a half-expired roster and persists its next epoch across restart',async t=>{
  const f=await fixture(t),circle=await create(f),home=await f.home(),remote=f.circles.get(circle);
  const root=createPrivateKey(await readFile(join(home,'v1','roots',circle+'.pem')));
  const seconds=Math.floor(Date.now()/1000),at=n=>new Date(n*1000).toISOString().replace('.000Z','Z');
  const old=signEnvelope('roster',{...remote.roster.payload,issued_at:at(seconds-5*86400),valid_until:at(seconds+2*86400)},root);
  remote.roster=old;
  const cachePath=join(home,'v1','circles',circle,'roster.json');
  await writeFile(cachePath,JSON.stringify({current:old,history:[],highestAcceptedEpoch:1,highestAcceptedDigest:digest(old.payload)}));
  const renewed=await f.cli(['circle','invite','--circle',circle]);assert.equal(renewed.code,0,renewed.stderr);
  assert.equal(remote.roster.payload.epoch,2);
  const cache=JSON.parse(await readFile(cachePath,'utf8'));assert.equal(cache.highestAcceptedEpoch,2);
  assert.equal(cache.highestAcceptedDigest,digest(remote.roster.payload));
  const again=await f.cli(['circle','list']);assert.equal(again.code,0,again.stderr);
  assert.equal(JSON.parse(await readFile(cachePath,'utf8')).highestAcceptedEpoch,2);
});

test('concurrent submits cannot race the same durable operation intent',async t=>{
  const f=await fixture(t),circle=await create(f);
  const args=['job','submit','--yes','--git',git,'--prompt','Concurrent synthetic intent','--circle',circle,'--json'];
  let arrived,release;
  const received=new Promise(resolve=>arrived=resolve),gate=new Promise(resolve=>release=resolve);
  f.override=async({req,route})=>{if(req.method==='POST'&&route==='/jobs'){arrived();await gate;}return false;};
  const first=f.cli(args);
  try {
    await Promise.race([received,first.then(r=>{throw new Error('First submit ended before publish: '+r.stdout+r.stderr);})]);
    const second=await f.cli(args);assert.equal(second.code,4,second.stdout+second.stderr);
    assert.equal(JSON.parse(second.stdout).code,'device_busy');
  } finally {release();}
  const submitted=parseOne(await first);assert.equal(f.jobs.size,1);assert.equal(submitted.jobDigest,[...f.jobs.keys()][0]);
});

const lockModuleURL=new URL('../lib/v1/lock.mjs',import.meta.url).href;
function lockChild(t,script,...args) {
  const child=spawn(process.execPath,['--input-type=module','-e',script,...args],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const ended=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>resolve({code,signal,stderr}));
  });
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  const ready=new Promise((resolve,reject)=>{
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready\n'))resolve();});
    ended.then(result=>reject(new Error('Lock child exited before ready: '+JSON.stringify(result))),reject);
  });
  return {child,ready,ended};
}

test('M6 a SIGKILLed device operation lock recovers; a live owner remains exclusive',async t=>{
  const f=await fixture(t),circle=await create(f),home=await f.home();
  const holder=lockChild(t,`
    const {openDevice}=await import(process.argv[1]);
    const device=await openDevice({home:process.argv[2],ensureDefault:false});
    await device.withOperationLock(process.argv[3],async()=>{
      console.log('ready');await new Promise(()=>{setInterval(()=>{},1000);});
    });
  `,new URL('../lib/v1/device.mjs',import.meta.url).href,home,circle);
  await holder.ready;
  const args=['job','submit','--yes','--git',git,'--prompt','Crash recovery','--circle',circle,'--json'];
  const live=await f.cli(args);
  assert.equal(live.code,4,live.stdout+live.stderr);
  assert.equal(JSON.parse(live.stdout).code,'device_busy');
  holder.child.kill('SIGKILL');await holder.ended;
  const recovered=await f.cli(args);
  assert.equal(recovered.code,0,recovered.stdout+recovered.stderr);
  assert.equal(f.jobs.size,1);
});

test('M6 process identity fences PID reuse and unknown/legacy owners fail closed',async t=>{
  const {acquireProcessLockSync}=await import(lockModuleURL);
  const f=await fixture(t),lock=join(f.root,'identity.lock'),directory=lock+'.owners-v1';
  const release=acquireProcessLockSync(lock),entry=(await readdir(directory)).find(name=>name.endsWith('.choosing'));
  const record=JSON.parse(await readlink(join(directory,entry)));
  assert.equal(record.pid,process.pid);assert.match(record.start,/^\d+$/);
  assert.throws(()=>acquireProcessLockSync(lock),{code:'lock_busy'});
  release();release();
  // Simulate a durable entry whose old PID has been reused by this live process.
  if(record.boot!==null) {
    await symlink(JSON.stringify({...record,start:record.start==='1'?'2':'1'}),join(directory,entry));
    const recovered=acquireProcessLockSync(lock);recovered();
    assert.deepEqual(await readdir(directory),[]);
  }
  await symlink('unreadable owner record',join(directory,entry));
  assert.throws(()=>acquireProcessLockSync(lock),{code:'lock_busy'});
  await unlink(join(directory,entry));
  await mkdir(lock);
  assert.throws(()=>acquireProcessLockSync(lock),{code:'lock_busy'});
});

test('M6 concurrent processes recover dead owner without stealing replacement or overlapping',async t=>{
  const f=await fixture(t),lock=join(f.root,'race.lock'),critical=join(f.root,'critical');
  const holder=lockChild(t,`
    const {acquireProcessLockSync}=await import(process.argv[1]);
    acquireProcessLockSync(process.argv[2]);
    console.log('ready');setInterval(()=>{},1000);
  `,lockModuleURL,lock);
  await holder.ready;holder.child.kill('SIGKILL');await holder.ended;
  const children=Array.from({length:6},()=>lockChild(t,`
    import fs from 'node:fs';
    import {setTimeout as sleep} from 'node:timers/promises';
    const {acquireProcessLock}=await import(process.argv[1]);
    console.log('ready');
    for(let n=0;n<8;n++) {
      const release=await acquireProcessLock(process.argv[2],{timeoutMs:10000,pollMs:2});
      const fd=fs.openSync(process.argv[3],'wx');
      try {await sleep(3);}finally {fs.closeSync(fd);fs.unlinkSync(process.argv[3]);release();}
    }
  `,lockModuleURL,lock,critical));
  await Promise.all(children.map(c=>c.ready));
  for(const result of await Promise.all(children.map(c=>c.ended)))assert.equal(result.code,0,result.stderr);
  assert.deepEqual(await readdir(lock+'.owners-v1'),[]);
});

test('M6 a choosing-to-ticket transition cannot disappear from an acquisition scan',async t=>{
  const fs=(await import('node:fs')).default;
  const {acquireProcessLockSync}=await import(lockModuleURL);
  const f=await fixture(t),lock=join(f.root,'transition.lock'),directory=lock+'.owners-v1';
  const seedRelease=acquireProcessLockSync(lock),[seedName]=fs.readdirSync(directory);
  const seed=JSON.parse(fs.readlinkSync(join(directory,seedName)));seedRelease();
  const {ticket:unused,...identity}=seed;
  const contender={...identity,token:'00000000-0000-0000-0000-000000000000'};
  const choosing=join(directory,contender.token+'.choosing'),ticket=join(directory,contender.token+'.ticket');
  fs.symlinkSync(JSON.stringify(contender),choosing);
  const original=fs.readlinkSync;
  let reads=0,acquired;
  try {
    fs.readlinkSync=function(file,...args) {
      if(file===choosing && ++reads===2) {
        // Both selected ticket 1. The earlier UUID is entitled to enter once
        // our choosing record disappears, so this acquisition must not enter.
        fs.symlinkSync(JSON.stringify({...contender,ticket:'1'}),ticket);
        fs.unlinkSync(choosing);
      }
      return original.call(this,file,...args);
    };
    assert.throws(()=>{acquired=acquireProcessLockSync(lock);},{code:'lock_busy'});
    assert.equal(reads,2,'transition occurred during the final scan');
    assert.equal(fs.readdirSync(directory).length,1,'failed contender withdrew only its own records');
  } finally {
    fs.readlinkSync=original;acquired?.();
    for(const file of [choosing,ticket])try {fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
});

test('M6 stable registrations expose tickets published after directory enumeration',async t=>{
  const fs=(await import('node:fs')).default;
  const {acquireProcessLockSync}=await import(lockModuleURL);
  const f=await fixture(t),lock=join(f.root,'stable-registration.lock'),directory=lock+'.owners-v1';
  const seedRelease=acquireProcessLockSync(lock),names=fs.readdirSync(directory);
  assert.equal(names.length,2,'ownership retains both registration and ticket');
  const seedName=names.find(name=>name.endsWith('.choosing'));
  assert.ok(seedName,'registration remains present for the whole acquisition');
  const identity=JSON.parse(fs.readlinkSync(join(directory,seedName)));seedRelease();
  const contender={...identity,token:'00000000-0000-0000-0000-000000000000'};
  const choosing=join(directory,contender.token+'.choosing'),ticket=join(directory,contender.token+'.ticket');
  fs.symlinkSync(JSON.stringify(contender),choosing);
  const original=fs.readlinkSync;
  let reads=0,acquired;
  try {
    fs.readlinkSync=function(file,...args) {
      if(file===choosing && ++reads===2) {
        // The snapshot names only the registration. Its new ticket must be
        // discovered by direct lookup, without relying on a second directory entry.
        fs.symlinkSync(JSON.stringify({...contender,ticket:'1'}),ticket);
      }
      return original.call(this,file,...args);
    };
    assert.throws(()=>{acquired=acquireProcessLockSync(lock);},{code:'lock_busy'});
    assert.equal(reads,2);
    assert.deepEqual(fs.readdirSync(directory).sort(),[contender.token+'.choosing',contender.token+'.ticket']);
  } finally {
    fs.readlinkSync=original;acquired?.();
    for(const file of [ticket,choosing])try {fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
});

test('offline create succeeds locally and explains provisioning with an injected failed transport',async t=>{
  const f=await fixture(t),home=await f.home('offline-create');
  let calls=0;
  const device=await openDevice({home,ensureDefault:false,clientOptions:{retry:{maxAttempts:1}},
    fetch:async()=>{calls++;throw new TypeError('synthetic offline');}});
  let stdout='',stderr='';
  const code=await runV1Command(['circle','create','https://queue.example','--name','Offline circle'],{
    device,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});
  assert.equal(code,0,stderr);assert.ok(calls>0);
  assert.match(stdout,/Circle created locally: Offline circle/);
  assert.match(stdout,/Server setup: faravan-coordinator --v1-provision/);
  const circle=device.selectCircle('Offline circle');
  assert.equal(circle.publicationPending,true);
  const provision=JSON.parse(await readFile(circle.provisioningPath,'utf8'));
  assert.equal(provision.roster.payload.coordinator,'https://queue.example');
  assert.equal(protocol.verifyEnvelope('roster',provision.roster,provision.roster.payload.root_public_key).ok,true);
  assert.equal((await device.intentStore(circle.id).get('roster-publication')).kind,'roster');
  const again=await device.createCircle('https://queue.example',{name:'Offline circle',publish:false});
  assert.equal(again.id,circle.id);
});

test('LAN provisioning and invite bind mode and display name; join warns before sending',async t=>{
  const f=await fixture(t),origin='http://10.23.4.5:9000';
  const owner=await openDevice({home:await f.home('lan-owner'),ensureDefault:false});
  const circle=await owner.createCircle(origin,{name:'Kitchen circle',publish:false,lanMode:true});
  const provisioning=JSON.parse(await readFile(circle.provisioningPath,'utf8'));
  assert.equal(provisioning.lan_mode,true);
  assert.equal(provisioning.roster.payload.lan_mode,true);
  assert.equal(provisioning.roster.payload.coordinator,origin);
  await assert.rejects(()=>owner.createCircle(origin,{name:'Kitchen circle',publish:false}),/invalid_origin/);
  await assert.rejects(()=>owner.createCircle('http://public.example',{publish:false,lanMode:true}),/invalid_origin/);
  const root=createPrivateKey(await readFile(join(await f.home('lan-owner'),'v1','roots',circle.id+'.pem')));
  const seed=Buffer.alloc(32,17),key=protocol.privateKeyFromSeed(seed),now=Math.floor(Date.now()/1000);
  const invite=protocol.createInvite({circle:circle.id,coordinator:origin,display_name:circle.name,lan_mode:true,
    invite_id:'11111111-1111-4111-8111-111111111111',invite_public_key:protocol.exportPublicKey(key),
    created_at:new Date(now*1000).toISOString().replace('.000Z','Z'),
    expires_at:new Date((now+3600)*1000).toISOString().replace('.000Z','Z')},root);
  let warned=false,requested=false;
  const joiner=await openDevice({home:await f.home('lan-joiner'),ensureDefault:false,fetch:async(url,options)=>{
    assert.equal(warned,true,'warning precedes upload');requested=true;
    assert.equal(new URL(url).origin,origin);
    const request=JSON.parse(Buffer.from(options.headers['Faravan-Proof'],'base64url'));
    assert.equal(request.payload.lan_mode,true);
    const body=JSON.parse(options.body),device_key_id=protocol.fingerprint(body.device_public_key);
    return new Response(protocol.canonicalize({enrollment_id:'22222222-2222-4222-8222-222222222222',
      state:'pending',device_key_id,roster:null}),{status:201,headers:{'content-type':'application/json'}});
  }});
  const joined=await joiner.joinCircle(protocol.encodeInviteLink(invite,seed),{onWarning:warning=>{
    assert.equal(warning,protocol.LAN_WARNING);warned=true;
  }});
  assert.equal(requested,true);assert.equal(joined.name,'Kitchen circle');
  assert.equal(joined.warning,protocol.LAN_WARNING);assert.equal(joined.lanMode,true);
});

test('human status and wait provide next actions while JSON retains stable vocabulary',async()=>{
  const view={state:'queued',status:'Waiting',job_digest:'sha256:'+'a'.repeat(64),current_attempt:null};
  assert.equal(statusMessage(view),'Waiting · Check again shortly.');
  for(const action of ['status','wait']) {
    let stdout='';
    const code=await runV1Command(['job',action,view.job_digest],{
      operations:{get:async()=>view,wait:async()=>view},stdout:{write:s=>stdout+=s}});
    assert.equal(code,0);assert.match(stdout,/Waiting · Check again shortly\./);
  }
  assert.match(statusMessage({...view,state:'result-accepted'}),/review and test/);
  const accepted={...view,state:'result-accepted'},id=shortId(view.job_digest);
  for(const kind of ['message','files']) {
    const text=statusMessage({...accepted,resultKind:kind});
    assert.doesNotMatch(text,/faravan apply/,kind+' results have no branch to apply');
    assert.match(text,new RegExp('faravan job result '+id+' --out '));
  }
  assert.match(statusMessage({...accepted,resultKind:'branch'}),/faravan apply /);
  assert.match(statusMessage({...accepted,job:{payload:{result:{kind:'message'}}}}),/faravan job result /,'a raw signed job still selects by its payload');
  assert.match(statusMessage({...view,state:'cancelled',current_attempt:{compute_stopped:false}}),/not confirmed/);
});

for(const [kind,expected] of [['message','message'],['files','files'],['branch','branch']]) {
  test('real status and wait operations choose the next step for a '+kind+' result',async t=>{
    const job={job_digest:bindingDigest,state:'result-accepted',attempts_started:1,result_digest:null,current_attempt:bindingAttempt(),
      job:{payload:{result:{kind}}}};
    const {ops}=await bindingOperations(t,{getJob:async()=>job,waitForJob:async()=>job});
    const id=shortId(bindingDigest);
    for(const action of ['status','wait']) {
      let stdout='';
      assert.equal(await runV1Command(['job',action,bindingDigest],{operations:ops,stdout:{write:s=>stdout+=s}}),0);
      const step=expected==='branch'
        ? 'Ready to review. Run faravan apply '+id+' to put the changes on a new branch, then review and test it.'
        : 'Ready to review. Run faravan job result '+id+' --out ./review-result to download the answer, then read it before you use it.';
      assert.ok(stdout.includes(step),action+' for a '+kind+' result printed: '+stdout);
      if(expected!=='branch')assert.doesNotMatch(stdout,/faravan apply/);
    }
  });
}

test('client rejects mismatched cached and published LAN roster bindings before transport',async t=>{
  const f=await fixture(t),home=await f.home('binding-owner'),origin='http://10.4.3.2:9000';
  const owner=await openDevice({home,ensureDefault:false});
  const circle=await owner.createCircle(origin,{name:'Bound circle',publish:false,lanMode:true});
  const root=createPrivateKey(await readFile(join(home,'v1','roots',circle.id+'.pem')));
  const snapshot=await owner.rosterCache(circle.id).get();
  let requests=0;
  const fetch=async()=>{requests++;throw new Error('must not send');};
  for(const change of [{coordinator:'http://10.4.3.3:9000'},{lan_mode:undefined,coordinator:'https://queue.example'}]) {
    const payload={...snapshot.current.payload,...change};
    if(payload.lan_mode===undefined)delete payload.lan_mode;
    const current=protocol.signEnvelope('roster',payload,root);
    const bad={...snapshot,current,highestAcceptedDigest:protocol.digest(payload)};
    const client=createClient({origin,circle:circle.id,pinnedRootFingerprint:circle.pinnedRootFingerprint,
      deviceKey:owner.deviceKey,lanMode:true,rosterCache:{get:async()=>bad,set:async()=>{}},fetch});
    await assert.rejects(()=>client.refreshRoster(),error=>['wrong_origin','transport_mismatch'].includes(error.code));
    const goodClient=createClient({origin,circle:circle.id,pinnedRootFingerprint:circle.pinnedRootFingerprint,
      deviceKey:owner.deviceKey,lanMode:true,rosterCache:{get:async()=>snapshot,set:async()=>{}},fetch});
    const next=protocol.signEnvelope('roster',{...payload,epoch:2},root);
    await assert.rejects(()=>goodClient.publishRoster(next),error=>['wrong_origin','transport_mismatch'].includes(error.code));
  }
  assert.equal(requests,0);
});

// --- faravan run, short IDs, per-command help, v1 status ---------------------------------
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { openDevice as openDeviceForTest } from '../lib/v1/device.mjs';
import { shortId, classifyJobId } from '../lib/v1/job-id.mjs';
import { helpFor, COMMANDS } from '../lib/v1/help.mjs';

const gitIn = (cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'});
function makeRepo(f) {
  const dir=mkdtempSync(join(f.root,'repo-'));
  gitIn(dir,'init','-q','-b','main');gitIn(dir,'config','user.email','t@example.test');gitIn(dir,'config','user.name','T');
  return dir;
}
async function commitFile(dir,name,text) {
  await writeFile(join(dir,name),text);gitIn(dir,'add','-A');gitIn(dir,'commit','-q','-m','add '+name);
}
const tarNames = gz=>{const file=mkdtempSync(join(tmpdir(),'v1-tar-'))+'/s.tar';
  return writeFile(file,gunzipSync(gz)).then(()=>execFileSync('tar',['-tf',file],{encoding:'utf8'}).split('\n').filter(Boolean).map(n=>n.replace(/^\.\//,'')));};
import { tmpdir } from 'node:os';
async function run(f,argv,extra={}) {
  let stdout='',stderr='';
  const code=await runV1Command(argv,{home:await f.home(),pollMs:20,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s},...extra});
  return {code,stdout,stderr};
}

test('run forwards its check command into the signed job', async t => {
  const f=await fixture(t),circle=await create(f),repo=makeRepo(f);
  await commitFile(repo,'README.md','Synthetic source\n');
  const result=await run(f,['run','--yes','Fix it','--circle',circle,'--verify-cmd','npm test','--detach','--json'],{cwd:repo});
  assert.equal(result.code,0,result.stderr);
  const job=f.jobs.get(JSON.parse(result.stdout).job_digest).job.payload;
  assert.deepEqual(job.verify,{cmd:'npm test'});
  assert.ok(job.requirements.capabilities.includes('verify_v1'));
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sourceNames=(f,id)=>tarNames(f.artifacts.get(f.jobs.get(id).job.payload.source.artifact.digest));

test('run --detach submits the committed HEAD of the current repository and prints a short ID',async t=>{
  const f=await fixture(t),circle=await create(f),repo=makeRepo(f);
  await commitFile(repo,'tracked.txt','committed\n');
  const before=f.requests.length;
  const out=await run(f,['run','--yes','--detach','--harness','claude-code-subscription','--model','m1','--egress','provider-only','fix the bug'],{cwd:repo});
  assert.equal(out.code,0,out.stderr);
  const id=[...f.jobs.keys()][0],short=shortId(id);
  assert.match(out.stdout,new RegExp('Job '+short+' submitted to Synthetic circle'));
  assert.doesNotMatch(out.stdout,/sha256:/,'human output uses short IDs');
  assert.match(out.stdout,new RegExp('faravan job status '+short));
  assert.equal(f.requests.slice(before).filter(r=>r.method==='GET'&&r.route.startsWith('/jobs/')).length,0,'--detach must not poll');
  const payload=f.jobs.get(id).job.payload;
  assert.deepEqual(payload.requirements.harness,['claude-code-subscription']);assert.equal(payload.requirements.egress,'provider-only');
  assert.deepEqual(await sourceNames(f,id),['tracked.txt']);
  const json=await run(f,['run','--yes','--detach','--json','another prompt'],{cwd:repo});
  assert.equal(json.code,0,json.stderr);const value=JSON.parse(json.stdout);
  assert.equal(value.detached,true);assert.match(value.job_digest,/^sha256:[0-9a-f]{64}$/);assert.equal(json.stdout.trim().split('\n').length,1);
  assert.ok(circle);
});

test('run refuses a dirty tree, naming the files; --include-uncommitted lists and sends them',async t=>{
  const f=await fixture(t);await create(f);const repo=makeRepo(f);
  await commitFile(repo,'tracked.txt','one\n');
  await writeFile(join(repo,'tracked.txt'),'two\n');await writeFile(join(repo,'new-file.txt'),'fresh\n');
  const refused=await run(f,['run','--yes','--detach','do it'],{cwd:repo});
  assert.equal(refused.code,2);assert.match(refused.stderr,/uncommitted changes/);
  assert.match(refused.stderr,/tracked\.txt/);assert.match(refused.stderr,/new-file\.txt/);assert.match(refused.stderr,/--include-uncommitted/);
  assert.equal(f.jobs.size,0,'nothing is submitted when refused');
  const sent=await run(f,['run','--yes','--detach','--include-uncommitted','do it'],{cwd:repo});
  assert.equal(sent.code,0,sent.stderr);
  assert.match(sent.stderr,/Including 2 uncommitted files/);assert.match(sent.stderr,/M tracked\.txt/);assert.match(sent.stderr,/\? new-file\.txt/);
  const id=[...f.jobs.keys()][0];
  assert.deepEqual((await sourceNames(f,id)).sort(),['new-file.txt','tracked.txt']);
  const json=await run(f,['run','--yes','--detach','--include-uncommitted','--json','again'],{cwd:repo});
  assert.equal(json.code,0,json.stderr+'\n'+json.stdout);
  assert.deepEqual(JSON.parse(json.stdout).uncommitted_files.sort(),['new-file.txt','tracked.txt']);assert.equal(json.stderr,'');
});

test('run outside a git repository, without commits, or without a circle explains what to do',async t=>{
  const f=await fixture(t);const plain=join(f.root,'plain');await mkdir(plain);
  const noRepo=await run(f,['run','--yes','x'],{cwd:plain});assert.equal(noRepo.code,2);assert.match(noRepo.stderr,/inside a git repository/);
  const empty=makeRepo(f);const noCommits=await run(f,['run','--yes','x'],{cwd:empty});assert.equal(noCommits.code,2);assert.match(noCommits.stderr,/no commits/);
  await commitFile(empty,'a.txt','a\n');
  const noCircle=await run(f,['run','--yes','x'],{cwd:empty});assert.equal(noCircle.code,2);assert.match(noCircle.stderr,/no confirmed circle with a server/);
  const noPrompt=await run(f,['run'],{cwd:empty});assert.equal(noPrompt.code,2);assert.match(noPrompt.stderr,/Describe what you want/);
});

test('run streams status lines until a lender finishes the job, then prints how to get the result',async t=>{
  const f=await fixture(t);await create(f);const repo=makeRepo(f);await commitFile(repo,'a.txt','a\n');
  const lender=(async()=>{
    while(!f.jobs.size)await sleep(10);const id=[...f.jobs.keys()][0];
    while(!f.requests.some(r=>r.method==='GET'&&r.route==='/jobs/'+id.slice(7)))await sleep(10);
    await f.complete(id);
  })();
  const out=await run(f,['run','--yes','add a test'],{cwd:repo});await lender;
  const id=[...f.jobs.keys()][0],short=shortId(id);
  assert.equal(out.code,0,out.stderr);
  const lines=out.stdout.trim().split('\n');
  assert.match(lines[0],/^Job [0-9a-f]{8} submitted/);
  assert.ok(lines.some(l=>/^Waiting · Check again shortly\.$/.test(l)),out.stdout);
  assert.ok(lines.some(l=>/^Ready to review\./.test(l)),out.stdout);
  assert.equal(lines.filter(l=>l.startsWith('Waiting')).length,1,'a status line prints only when the status changes');
  assert.match(out.stdout,new RegExp('faravan apply '+short));
  assert.doesNotMatch(out.stdout,/sha256:/);
  // The legacy download form still works with the short ID.
  const dest=join(f.root,'got');
  const got=await run(f,['job','result',short,'--out',dest]);assert.equal(got.code,0,got.stderr);
  assert.equal(await readFile(join(dest,'summary.txt'),'utf8'),'Synthetic verified result\n');
});

test('run --json prints one final value; --json --follow prints JSONL events; failed jobs exit 1',async t=>{
  const f=await fixture(t);await create(f);const repo=makeRepo(f);await commitFile(repo,'a.txt','a\n');
  // Stop the synthetic lender when submission fails; otherwise it would wait
  // forever for a job that was never published and hide the real CLI error.
  const finish=async(state,args)=>{
    const n=f.jobs.size;let waiting=true,lenderError;
    const lender=(async()=>{while(waiting&&f.jobs.size===n)await sleep(10);if(!waiting)return;
      const id=[...f.jobs.keys()].at(-1);
      while(waiting&&!f.requests.some(r=>r.method==='GET'&&r.route==='/jobs/'+id.slice(7)))await sleep(10);
      if(!waiting)return;if(state==='failed')f.jobs.get(id).state='failed';else await f.complete(id);
    })().catch(error=>{lenderError=error;});
    try {return await run(f,['run','--yes','--timeout','5',...args],{cwd:repo});}
    finally {waiting=false;await lender;if(lenderError)throw lenderError;}
  };
  const one=await finish('ok',['--json','first']);
  assert.equal(one.code,0,one.stderr);assert.equal(one.stdout.trim().split('\n').length,1);
  const value=JSON.parse(one.stdout);assert.equal(value.status,'Finished');assert.match(value.job_digest,/^sha256:[0-9a-f]{64}$/);
  assert.match(value.next,/^faravan apply [0-9a-f]{8}$/);
  const follow=await finish('ok',['--json','--follow','second']);
  assert.equal(follow.code,0,follow.stderr);
  const events=follow.stdout.trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(events.map(e=>e.event),['submitted','status','status','finished'].slice(0,events.length));
  assert.equal(events[0].event,'submitted');assert.equal(events.at(-1).event,'finished');assert.equal(events.at(-1).status,'Finished');
  const failed=await finish('failed',['third']);
  assert.equal(failed.code,1);assert.match(failed.stdout,/^The action could not be completed\. Check the job status for details\./m);
});

test('run --attach follows an existing job by short ID; a timeout leaves the job running',async t=>{
  const f=await fixture(t);await create(f);const repo=makeRepo(f);await commitFile(repo,'a.txt','a\n');
  assert.equal((await run(f,['run','--yes','--detach','go'],{cwd:repo})).code,0);
  const id=[...f.jobs.keys()][0],short=shortId(id);
  const slow=await run(f,['run','--attach',short,'--timeout','0.1']);
  assert.equal(slow.code,5);assert.match(slow.stdout,new RegExp('faravan run --attach '+short));
  const lender=(async()=>{await sleep(80);await f.complete(id);})();
  const done=await run(f,['run','--attach',short]);await lender;
  assert.equal(done.code,0,done.stderr);assert.match(done.stdout,/Ready to review/);
});

test('job commands accept unique prefixes (with or without sha256:) and reject short, unknown and ambiguous ones',async t=>{
  const f=await fixture(t),circle=await create(f),id=await submit(f,circle),hex=id.slice(7);
  for(const input of [hex.slice(0,8),'sha256:'+hex.slice(0,6),hex.slice(0,20).toUpperCase(),id]) {
    const out=await run(f,['job','status',input,'--json']);assert.equal(out.code,0,input+out.stderr);
    assert.equal(JSON.parse(out.stdout).job_digest,id,'JSON keeps the full digest');
  }
  const human=await run(f,['job','status',hex.slice(0,8)]);
  assert.match(human.stdout,new RegExp('Job: '+hex.slice(0,8)+'$','m'));assert.doesNotMatch(human.stdout,/sha256:/);
  assert.match((await run(f,['job','list'])).stdout,new RegExp('^'+hex.slice(0,8)+'  Waiting','m'));
  const tooShort=await run(f,['job','status',hex.slice(0,5)]);assert.equal(tooShort.code,2);assert.match(tooShort.stderr,/at least 6/);
  const junk=await run(f,['job','status','zzzzzzzz']);assert.equal(junk.code,2);
  const other=(hex[0]==='0'?'1':'0')+'abcde';
  const unknown=await run(f,['job','status',other+'12']);assert.equal(unknown.code,3,unknown.stderr);
  // wait / cancel / result resolve prefixes too.
  assert.equal((await run(f,['job','wait',hex.slice(0,8),'--timeout','0'])).code,0);
  assert.equal((await run(f,['job','cancel',hex.slice(0,8)])).code,0);
  assert.equal(JSON.parse((await run(f,['job','status',hex.slice(0,8),'--json'])).stdout).status,'Cancelled');
});

test('an ambiguous prefix lists the matching jobs and sends no request',async t=>{
  const f=await fixture(t),circle=await create(f);
  const device=await openDeviceForTest({home:await f.home()}),store=device.intentStore(circle);
  const a='sha256:abcdef'+'1'.repeat(58),b='sha256:abcdef'+'2'.repeat(58);
  await store.set('job:'+a,{jobDigest:a,circle});await store.set('job:'+b,{jobDigest:b,circle});
  const before=f.requests.length;
  const out=await run(f,['job','status','abcdef']);
  assert.equal(out.code,2);assert.match(out.stderr,/more than one job/);
  assert.match(out.stderr,/abcdef11/);assert.match(out.stderr,/abcdef22/);
  assert.equal(f.requests.length,before);
  const unique=await run(f,['job','cancel','sha256:abcdef2','--json']);assert.notEqual(unique.code,2,'a longer prefix disambiguates');
  assert.deepEqual(classifyJobId('abc'),{kind:'invalid',reason:'short'});
  assert.equal(shortId(a),'abcdef11');
});

test('every command has real help: usage, options and an example, exit 0',async t=>{
  const paths=[];
  for(const [verb,entry] of Object.entries(COMMANDS)) { paths.push([verb]); for(const action of Object.keys(entry.actions??{})) paths.push([verb,action]); }
  const f=await fixture(t);
  for(const path of paths) {
    const viaV1=['app','run','job','circle','mcp','status','name'].includes(path[0]);
    const out=viaV1?await run(f,[...path,'--help']):await f.cli([...path,'--help']);
    assert.equal(out.code,0,path.join(' ')+out.stderr);
    const text=out.stdout;
    assert.match(text,/^Usage: faravan /m,path.join(' '));assert.match(text,/^Example:\n  faravan /m,path.join(' '));
    assert.ok(text.includes(path.join(' ')),'help names its own command: '+path.join(' '));
    assert.equal(text,helpFor(path),'help text is the registry text');
  }
  const action=await run(f,['job','submit','--help']);
  assert.match(action.stdout,/--source DIR/);assert.doesNotMatch(action.stdout,/^Usage: faravan job submit\|status/m);
  assert.match((await run(f,['help','run'])).stdout,/Usage: faravan run/);
});

test('status shows this device, circles, lending state and recent jobs',async t=>{
  const f=await fixture(t),circle=await create(f),id=await submit(f,circle);
  const human=await run(f,['status']);assert.equal(human.code,0,human.stderr);
  assert.match(human.stdout,/^This device: .+ \([0-9a-f]{8}\)$/m);
  assert.match(human.stdout,/^Lending:\s+Not running  \(start the app with: faravan app\)$/m);
  assert.match(human.stdout,/Synthetic circle\s+http:\/\/127\.0\.0\.1:\d+\s+\(you host it\)/);
  assert.match(human.stdout,/My devices\s+this computer only/);
  assert.match(human.stdout,new RegExp('^  '+shortId(id)+'  Waiting\\s+Synthetic circle$','m'));
  assert.doesNotMatch(human.stdout,/not joined/i);
  const json=JSON.parse((await run(f,['status','--json'])).stdout);
  assert.equal(json.jobs[0].job_digest,id);assert.equal(json.lending.app_running,false);assert.equal(json.circles.length,2);
});

// Retained-attempt caller regressions use synthetic clients; no provider runs.
const bindingDigest='sha256:'+'1'.repeat(64);
const bindingAttempt=()=>({job_digest:bindingDigest,attempt_id:'earlier-attempt',generation:1,holder:'earlier-holder'});
async function bindingOperations(t,client) {
  const home=await mkdtemp(join(tmpdir(),'faravan-caller-binding-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const device={listCircles:async()=>[{id:'first'},{id:'second'}],
    selectCircle:async name=>({id:name??'first'}),client:async()=>client,
    intentStore:()=>({list:async()=>[]})};
  return {home,ops:createJobOperations({device,home})};
}
for(const method of ['fetchReceipt','fetchResult','fetchTranscript']) {
  test('borrower '+method+' retains a separate job read before fetching',async t=>{
    const prior=bindingAttempt(),events=[],signal=new AbortController().signal;
    const {ops}=await bindingOperations(t,{
      getJob:async(digest,opts)=>{assert.equal(digest,bindingDigest);assert.equal(opts.signal,signal);events.push('job');return {job_digest:digest,state:'claimed',current_attempt:prior};},
      [method]:async(digest,opts)=>{events.push('result');assert.equal(digest,bindingDigest);assert.equal(opts.signal,signal);
        assert.equal(opts.includeMetadata,true);assert.deepEqual(opts.attempt,bindingAttempt());assert.notEqual(opts.attempt,prior);
        prior.holder='changed-after-observation';assert.equal(opts.attempt.holder,'earlier-holder');return 'verified';}
    });
    assert.equal(await ops[method]({digest:bindingDigest},{signal,includeMetadata:true}),'verified');
    assert.deepEqual(events,['job','result']);
  });
}
for(const observe of ['get','wait','list']) {
  test('borrower reuses a cloned earlier '+observe+' observation instead of rebinding during download',async t=>{
    const prior=bindingAttempt();let reads=0;
    const view=()=>({job_digest:bindingDigest,state:'result-accepted',current_attempt:prior,attempts_started:1,result_digest:null});
    const {ops}=await bindingOperations(t,{
      getJob:async()=>{reads++;return view();},waitForJob:async()=>{reads++;return view();},
      async *listJobs(){reads++;yield view();},
      fetchResult:async(_digest,{attempt})=>{assert.deepEqual(attempt,bindingAttempt());return 'verified';}
    });
    const observed=await ops[observe]({digest:bindingDigest});
    (Array.isArray(observed)?observed[0]:observed).current_attempt.holder='changed-by-caller';
    prior.generation=2;
    assert.equal(await ops.fetchResult({digest:bindingDigest}),'verified');
    assert.equal(reads,1,'download must not replace the previously retained binding');
  });
}
test('borrower attempt observations are isolated by circle and job',async t=>{
  let reads=0;const fetched=[];
  const {ops}=await bindingOperations(t,{
    getJob:async digest=>({job_digest:digest,state:'claimed',current_attempt:{...bindingAttempt(),job_digest:digest,generation:++reads}}),
    fetchResult:async(digest,{attempt})=>{fetched.push([digest,attempt.generation]);return 'verified';}
  });
  await ops.get({digest:bindingDigest,circle:'first'});
  await ops.fetchResult({digest:bindingDigest,circle:'second'});
  const other='sha256:'+'2'.repeat(64);
  await ops.fetchResult({digest:other,circle:'first'});
  await ops.fetchResult({digest:bindingDigest,circle:'first'});
  assert.deepEqual(fetched,[[bindingDigest,2],[other,3],[bindingDigest,1]]);
});
test('borrower never writes an output directory after retained-attempt verification fails',async t=>{
  const {home,ops}=await bindingOperations(t,{
    getJob:async()=>({job_digest:bindingDigest,state:'claimed',current_attempt:bindingAttempt()}),
    fetchResult:async(_digest,{attempt})=>{assert.deepEqual(attempt,bindingAttempt());throw Object.assign(new Error('mismatch'),{code:'stale_attempt'});}
  });
  const out=join(home,'must-not-exist');
  await assert.rejects(ops.readResult({digest:bindingDigest,out}),{code:'stale_attempt'});
  await assert.rejects(stat(out),{code:'ENOENT'});
});
test('MCP wait_job followed by read_result uses the retained shared-operations attempt',{timeout:5000},async t=>{
  let reads=0;const prior=bindingAttempt();
  const {home,ops}=await bindingOperations(t,{
    waitForJob:async()=>{reads++;return {job_digest:bindingDigest,state:'result-accepted',current_attempt:prior};},
    getJob:async()=>{throw new Error('must reuse the wait observation');},
    fetchResult:async(_digest,{attempt})=>{assert.deepEqual(attempt,bindingAttempt());return {bytes:Buffer.from('verified patch\n'),candidate:{media_type:'text/x-diff'}};}
  });
  const input=new PassThrough(),output=new PassThrough();let text='',waited,read;
  const ready=new Promise(resolve=>{waited=resolve;}),downloaded=new Promise(resolve=>{read=resolve;});
  output.on('data',chunk=>{text+=chunk;for(const line of text.split('\n').slice(0,-1)){
    const message=JSON.parse(line);if(message.id===2)waited();if(message.id===3)read();
  }});
  const running=runMcpServer({input,output,roots:[home],operations:ops});
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'wait_job',arguments:{digest:bindingDigest}}})+'\n');
  await ready;prior.holder='changed-after-wait';
  input.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_result',arguments:{digest:bindingDigest}}})+'\n');
  await downloaded;input.end();await running;
  const result=text.trim().split('\n').map(line=>JSON.parse(line)).find(message=>message.id===3);
  assert.equal(result.result.isError,undefined,JSON.stringify(result));
  assert.match(JSON.stringify(result),/Result ready/);assert.equal(reads,1);
});

for(const observe of ['get','wait','list']) {
  for(const stale of ['older','empty']) {
    test('borrower retains newer generation after delayed '+stale+' '+observe+' observation',async t=>{
      const latest={...bindingAttempt(),attempt_id:'newer-attempt',generation:2,holder:'newer-holder'};
      const older=stale==='older'?bindingAttempt():null;
      let reads=0,arrived,release;
      const entered=new Promise(resolve=>{arrived=resolve;}),gate=new Promise(resolve=>{release=resolve;});
      const read=async()=>{
        const current_attempt=++reads===1?older:latest;
        if(reads===1){arrived();await gate;}
        return {job_digest:bindingDigest,state:current_attempt?'result-accepted':'queued',current_attempt};
      };
      const check=async(_digest,{attempt})=>{assert.deepEqual(attempt,latest);return 'verified';};
      const {ops}=await bindingOperations(t,{
        getJob:read,waitForJob:read,async *listJobs(){yield await read();},
        fetchResult:check,fetchTranscript:check
      });
      const delayed=ops[observe]({digest:bindingDigest});
      try {await entered;await ops.get({digest:bindingDigest});}finally {release();}
      await delayed;
      for(const method of ['fetchResult','fetchTranscript'])
        assert.equal(await ops[method]({digest:bindingDigest}),'verified');
      assert.equal(reads,2,'an obsolete observation must not clear or replace the retained binding');
    });
  }
}
for(const observe of ['get','wait','list']) {
  for(const field of ['attempt_id','holder','job_digest']) {
    test('borrower rejects conflicting same-generation '+field+' from '+observe,async t=>{
      const prior=bindingAttempt();let current=prior,reads=0;
      const read=async()=>{reads++;return {job_digest:bindingDigest,state:'claimed',current_attempt:current};};
      const check=async(_digest,{attempt})=>{assert.deepEqual(attempt,prior);return 'verified';};
      const {ops}=await bindingOperations(t,{
        getJob:read,waitForJob:read,async *listJobs(){yield await read();},
        fetchResult:check,fetchTranscript:check
      });
      await ops.get({digest:bindingDigest});
      current={...prior,[field]:field==='job_digest'?'sha256:'+'2'.repeat(64):'conflicting-identity'};
      await assert.rejects(ops[observe]({digest:bindingDigest}),{code:'stale_attempt'});
      for(const method of ['fetchResult','fetchTranscript'])
        assert.equal(await ops[method]({digest:bindingDigest}),'verified');
      assert.equal(reads,2,'a rejected identity must leave the original binding intact');
    });
  }
}
test('borrower accepts matching identity updates and explicit newer-generation observations',async t=>{
  let current={...bindingAttempt(),state:'claimed'},reads=0;
  const read=async()=>{reads++;return {job_digest:bindingDigest,state:'claimed',current_attempt:current};};
  const check=async(_digest,{attempt})=>{assert.deepEqual(attempt,current);return 'verified';};
  const {ops}=await bindingOperations(t,{
    getJob:read,waitForJob:read,async *listJobs(){yield await read();},
    fetchResult:check,fetchTranscript:check
  });
  await ops.get({digest:bindingDigest});
  current={...current,state:'completed'};
  await ops.wait({digest:bindingDigest});
  assert.equal(await ops.fetchResult({digest:bindingDigest}),'verified');
  current={...current,attempt_id:'newer-attempt',generation:2,holder:'newer-holder'};
  await ops.list({});
  assert.equal(await ops.fetchTranscript({digest:bindingDigest}),'verified');
  assert.equal(reads,3);
});
for(const method of ['fetchResult','fetchTranscript']) {
  test('borrower '+method+' never repins or retries after verification failure',async t=>{
    const prior=bindingAttempt(),replacement={...prior,attempt_id:'replacement-attempt',generation:2};
    let reads=0,fetches=0;
    const {ops}=await bindingOperations(t,{
      getJob:async()=>({job_digest:bindingDigest,state:'claimed',current_attempt:++reads===1?prior:replacement}),
      [method]:async(_digest,{attempt})=>{
        fetches++;assert.deepEqual(attempt,prior);
        throw Object.assign(new Error('mismatch'),{code:'stale_attempt'});
      }
    });
    await ops.get({digest:bindingDigest});
    for(let n=0;n<2;n++) await assert.rejects(ops[method]({digest:bindingDigest}),{code:'stale_attempt'});
    assert.equal(fetches,2,'verification failure must not silently retry with a new identity');
    assert.equal(reads,1,'verification failure must not bootstrap or repin the retained binding');
  });
}

test('quit lending labels distinguish pending review from executing phases', async () => {
  const {lendingLabel} = await import('../lib/v1/status.mjs');
  assert.equal(lendingLabel({enabled: true, current: 'attempt', status: 'awaiting-approval'}), 'Waiting for review');
  for (const status of ['running', 'sending-result', 'stopping', 'failed'])
    assert.equal(lendingLabel({enabled: true, current: 'attempt', status}), 'Running a job');
  assert.equal(lendingLabel({enabled: true, current: null, status: 'idle'}), 'Lending on');
});

test('lending off keeps pending review in secondary status', async () => {
  const {lendingLabel, lendingStatusLines} = await import('../lib/v1/status.mjs');
  const lending = {enabled: false, status: 'awaiting-approval'};
  assert.equal(lendingLabel(lending), 'Lending off');
  assert.ok(lendingStatusLines(lending).some(line => line.includes('Waiting for review')));
  assert.equal(lendingLabel({...lending, current: 'attempt'}), 'Lending off');
  assert.equal(lendingLabel({...lending, enabled: true}), 'Waiting for review');
  assert.deepEqual(lendingStatusLines(null), []);
  assert.deepEqual(lendingStatusLines({enabled: false}), []);
});

test('paused-timed', async () => {
  const {lendingLabel} = await import('../lib/v1/status.mjs');
  const pause_until = Date.now() + 60 * 60 * 1000;
  assert.equal(lendingLabel({enabled: false, pause_until}), 'Paused until ' + new Date(pause_until).toISOString());
});

test('paused-indefinite', async () => {
  const {lendingLabel} = await import('../lib/v1/status.mjs');
  assert.equal(lendingLabel({enabled: false, paused: true}), 'Paused until resumed');
});

test('lending-off-with-running-job', async () => {
  const {lendingLabel} = await import('../lib/v1/status.mjs');
  assert.equal(lendingLabel({enabled: false, current: 'attempt', status: 'running'}), 'Running a job');
});

test('quit pending approval problem names only its safe request identifier', () => {
  const problem = problemForError({code: 'approval_pending', approvalId: '12345678-1234-1234-1234-123456789abc',
    message: 'secret prompt', prompt: 'secret prompt', token: 'secret token'});
  assert.equal(problem.approvalId, '12345678-1234-1234-1234-123456789abc');
  assert.ok(problem.message.includes(problem.approvalId));
  assert.doesNotMatch(JSON.stringify(problem), /secret/);
});

test('version and credential-store failures have fixed, actionable copy',()=>{
 for(const code of ['client_update_required','sandbox_credential_store_failed']){
  const problem=problemForError({code,message:'secret remote payload',problem:{detail:'secret remote payload'}});
  assert.doesNotMatch(problem.message,/secret remote payload/);
  assert.match(problem.message,code==='client_update_required'?/Update Faravan/:/saved Docker sign-in/);
 }
});

test('an unavailable own process identity has a plain retry reason',()=>{
 const problem=problemForError({code:'lock_identity_unavailable',message:'secret remote payload'});
 assert.match(problem.message,/process.*identity/i);assert.match(problem.message,/try.*again/i);
 assert.doesNotMatch(problem.message,/secret|already running|manually/i);
});

test('archive sends explain an older host instead of publishing unsupported signed fields',async t=>{
 const f=await fixture(t),circle=await create(f),folder=join(f.root,'old-host-source');await mkdir(folder);await writeFile(join(folder,'note.txt'),'fixture');
 f.override=async({req,res,route})=>{if(req.method==='GET'&&route==='/capabilities'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({capabilities:[]}));return true;}return false;};
 const out=await f.cli(['job','submit','--yes','--source',folder,'--prompt','Read source','--circle',circle,'--json']);
 assert.notEqual(out.code,0);assert.equal(JSON.parse(out.stdout).code,'host_too_old');assert.equal(f.jobs.size,0);
});

test('privacy N1: CLI keeps omitted names in local submission metadata across draft retries',async t=>{
 const f=await fixture(t),circle=await create(f),home=await f.home();
 const {createTar}=await import('../lib/tar-writer.mjs');
 const excluded='synthetic-confidential-project/.env.production';
 const sourceTar=createTar([{name:'main.js',type:'0',mode:0o600,data:Buffer.from('source')},
  {name:excluded,type:'0',mode:0o600,data:Buffer.from('synthetic excluded contents')}]);
 const ops=createJobOperations({home}),request={circle,sourceTar,prompt:'Read the source',draftId:'private-omissions-1028'};
 const sent=await ops.submit(request),job=f.jobs.get(sent.jobDigest).job;
 assert.doesNotMatch(JSON.stringify(job),/synthetic-confidential-project|\.env\.production/);
 assert.deepEqual(job.payload.source_manifest.not_sent,[{reason:'credentials',count:1}]);
 assert.deepEqual(sent.sourceOmissions,[{path:excluded,reason:'credentials'}]);
 const d=await openDevice({home});
 const intent=(await d.intentStore(circle).list()).find(value=>value.kind==='submit');
 assert.deepEqual(intent.sourceOmissions,sent.sourceOmissions);
 assert.doesNotMatch(JSON.stringify(intent.envelope),/synthetic-confidential-project|\.env\.production/);
 const replay=await ops.submit(request);
 assert.equal(replay.jobDigest,sent.jobDigest);assert.deepEqual(replay.sourceOmissions,sent.sourceOmissions);
 assert.ok(replay.warnings.includes('1 file not sent (looked like credentials)'),'CLI warning keeps its count and reason');
});

// An older client signed job manifests that still named excluded paths; signEnvelope now refuses to sign them.
// Same signing bytes as lib/protocol (see v1-enrollment-name.test.mjs).
function legacyJobEnvelope(payload,privateKey) {
 const bytes=Buffer.concat([Buffer.from('faravan/job/v1\0'),Buffer.from(digest(payload).slice(7),'hex')]);
 return {payload:JSON.parse(canonicalize(payload)),signature:{algorithm:'Ed25519',key_id:protocol.fingerprint(createPublicKey(privateKey)),
  value:sign(null,bytes,privateKey).toString('base64url')}};
}
test('privacy N1: an older pending intent with excluded names is resolved without resending',async t=>{
 const f=await fixture(t),circle=await create(f),home=await f.home();
 const {createTar}=await import('../lib/tar-writer.mjs');
 const sourceTar=createTar([{name:'main.js',type:'0',mode:0o600,data:Buffer.from('source')}]);
 const ops=createJobOperations({home}),request={circle,sourceTar,prompt:'Read old source',draftId:'legacy-omissions-1028'};
 const sent=await ops.submit(request),d=await openDevice({home}),store=d.intentStore(circle);
 const original=await store.get('submit:draft:'+request.draftId);
 const payload={...original.payload,source_manifest:{...original.payload.source_manifest,
  not_sent:[{path:'private/.env.production',reason:'credentials'}],not_sent_count:1}};
 const legacy={...original,state:'pending',payload,jobDigest:digest(payload),envelope:legacyJobEnvelope(payload,d.deviceKey),
  artifacts:{source:f.artifacts.get(payload.source.artifact.digest).toString('base64'),prompt:f.artifacts.get(payload.prompt.digest).toString('base64')}};
 await store.set('submit:draft:'+request.draftId,legacy);
 const before=f.requests.filter(r=>r.method==='POST'&&r.route==='/jobs').length;
 await assert.rejects(ops.submit(request),error=>error.code==='invalid_request'&&/names/.test(error.message));
 assert.equal(f.requests.filter(r=>r.method==='POST'&&r.route==='/jobs').length,before);
 // A possibly accepted legacy job can still be reconciled through its read API.
 f.jobs.set(legacy.jobDigest,{...f.jobs.get(sent.jobDigest),job_digest:legacy.jobDigest,job:legacy.envelope});
 assert.equal((await ops.submit(request)).jobDigest,legacy.jobDigest);
 assert.equal(f.requests.filter(r=>r.method==='POST'&&r.route==='/jobs').length,before);
});

test('new pinned Git sends require a host and lender that understand filtered snapshots',async t=>{
 const f=await fixture(t),circle=await create(f);
 f.override=async({req,res,route})=>{if(req.method==='GET'&&route==='/capabilities'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({capabilities:['source_manifest_v1','working_directory_v1','results_v1']}));return true;}return false;};
 const out=await f.cli(['job','submit','--yes','--git','https://example.test/project@'+'a'.repeat(40),'--prompt','Read pinned source','--circle',circle,'--json']);
 assert.notEqual(out.code,0);assert.equal(JSON.parse(out.stdout).code,'host_too_old');assert.equal(f.jobs.size,0);
});

test('legacy link rejection tells the user to refresh both computers and consent again',()=>{
  assert.match(problemForError({code:'person_link_refresh_required'}).message,/Refresh.*both computers.*new.*proof/i);
});

test('CLI distinguishes producer Off from Pause and preserves concurrent execution', async () => {
  const {lendingLabel, lendingStatusLines} = await import('../lib/v1/status.mjs');
  // app lendingView projects the saved intent; off/pause both disable admission and pause the lender.
  const until = Date.now() + 3600000;
  const cases = [
    [{intent:'off',enabled:false,paused:true,pause_until:null,current:null}, 'Lending off'],
    [{intent:'on',enabled:false,paused:true,pause_until:until,current:null}, 'Paused until ' + new Date(until).toISOString()],
    [{intent:'on',enabled:false,paused:true,pause_until:null,current:null}, 'Paused until resumed'],
    [{intent:'on',enabled:false,paused:true,pause_until:until,current:'attempt'}, 'Paused until ' + new Date(until).toISOString()],
    [{intent:'on',enabled:false,paused:true,pause_until:null,current:'attempt'}, 'Paused until resumed'],
    [{intent:'off',enabled:false,paused:true,pause_until:null,current:'attempt'}, 'Lending off'],
    [{intent:'on',enabled:true,paused:false,pause_until:null,current:'attempt',status:'running'}, 'Running a job'],
  ];
  for (const [view,label] of cases) {
    assert.equal(lendingLabel(view), label, JSON.stringify(view));
    if (view.current) assert.ok(lendingStatusLines(view).some(line => line.includes('Running a job')), 'execution stays independent');
  }
  assert.equal(lendingLabel({intent:'on',enabled:true,current:'attempt',status:'awaiting-approval'}), 'Waiting for review');
});
test('lending producer exposes its saved intent alongside admission state', async () => {
  const {readFile} = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
  const view = source.slice(source.indexOf('  function lendingView('), source.indexOf('  async function requesterView('));
  assert.match(view, /intent:\s*settings\.intent/);
});

test('circle create refuses an unreadable host config instead of calling it "not hosting"',async t=>{
  const f=await fixture(t),home=await f.home('unreadable-host');
  const coordinatorHome=join(home,'coordinator');await mkdir(coordinatorHome,{recursive:true});await writeFile(join(coordinatorHome,'host.json'),'{not json');
  const device=await openDevice({home,ensureDefault:false,clientOptions:{retry:{maxAttempts:1}},fetch:async()=>{throw new TypeError('offline');}});
  let stdout='',stderr='';
  const code=await runV1Command(['circle','create','--name','Mine','--json'],{device,home,coordinatorHome,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});
  assert.notEqual(code,0);assert.equal(JSON.parse(stdout).code,'host_config_unreadable');
  assert.doesNotMatch(stdout+stderr,/Start hosting first/);
});
