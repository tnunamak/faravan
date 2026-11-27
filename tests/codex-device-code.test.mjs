import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProviderGenerationAuth,deviceVerificationLink,stripTerminalCodes} from '../lib/provider-generation-auth.mjs';
import {createSignin,SIGNIN_DIAGNOSTIC_CODES} from '../lib/v1/signin.mjs';
import {CODEX_HARNESS,CLAUDE_CODE_HARNESS} from '../lib/harnesses.mjs';
import {freePort,fakeCodex,fakeCodexDevice,DEVICE_CODE,DEVICE_TEXT_COLORED} from './helpers/fake-codex-redirect.mjs';

async function setup(t,deviceOptions={},signinOptions={},providerOptions={}) {
  const home=await mkdtemp(join(tmpdir(),'codex-device-'));
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  const fake=await fakeCodexDevice(home,deviceOptions);
  const starts=[];
  const signin=createSignin({adapters:async()=>[{spec:CODEX_HARNESS},{spec:CLAUDE_CODE_HARNESS}],backend:()=>({}),onComplete:async()=>{},
    startProvider:(s,{onHandle,method})=>{starts.push(method);return startProviderGenerationAuth(s,{home,providerBin:fake.bin,onHandle,method,...providerOptions});},...signinOptions});
  t.after(()=>signin.close());
  return {home,fake,signin,starts};
}
const waitFor=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,25));}assert.fail('timed out');};
const argsOf=fake=>readFile(fake.argsLog,'utf8').catch(()=>'');
const skip={skip:process.platform==='win32'};
const ID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('Codex signs in with a device code by default: link and code shown, then complete',skip,async t=>{
  const {fake,signin}=await setup(t);
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.status,'awaiting_browser');
  assert.equal(flow.url,'https://auth.openai.com/codex/device');
  assert.equal(flow.code,DEVICE_CODE);
  assert.equal(flow.redirectEntry,undefined,'a device code flow has no paste field');
  assert.match(await argsOf(fake),/login --device-auth/);
  await waitFor(()=>signin.get(flow.flowId).status==='complete');
});

test('a device code flow stays open past the normal sign-in window',skip,async t=>{
  const {signin}=await setup(t,{waitMs:1500},{timeoutMs:300});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(signin.get(flow.flowId).status,'awaiting_browser','still waiting after the short window');
  await waitFor(()=>signin.get(flow.flowId).status==='complete');
});

test('the provider handle waits for both the link and the code',skip,async t=>{
  const {home,fake}=await setup(t);
  const handle=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:fake.bin});
  t.after(()=>handle.cancel());
  assert.equal(handle.url,'https://auth.openai.com/codex/device');
  assert.equal(handle.code,DEVICE_CODE);
  assert.equal(handle.acceptsRedirect,false);
  assert.ok(Math.abs(handle.expiresAt-(Date.now()+15*60_000))<5000,'the expiry is 15 minutes from when the code was seen');
});

test('OpenAI refusing a device code (403) ends the flow as codex_device_code_unavailable',skip,async t=>{
  const {signin}=await setup(t,{mode:'refused'});
  const started=await signin.begin(CODEX_HARNESS.harness_id,ID);
  assert.equal(started.status,'starting');
  const flow=await waitFor(()=>{const f=signin.get(ID);return f.status==='failed'&&f;});
  assert.equal(flow.reasonCode,'codex_device_code_unavailable');
  assert.ok(SIGNIN_DIAGNOSTIC_CODES.includes('codex_device_code_unavailable'));
});

for(const [name,status,reason] of [['401',401,'codex_device_code_unavailable'],['429',429,'codex_device_code_rate_limited'],['500',500,'codex_device_code_service_unavailable'],['503',503,'codex_device_code_service_unavailable'],['404',404,'codex_device_code_service_unavailable']])
  test('a '+name+' from OpenAI ends as '+reason,skip,async t=>{
    const {signin}=await setup(t,{mode:'refused',status});
    await signin.begin(CODEX_HARNESS.harness_id,ID);
    const flow=await waitFor(()=>{const f=signin.get(ID);return f.status==='failed'&&f;});
    assert.equal(flow.reasonCode,reason);
  });

test('a failed code exchange after the code was shown ends as codex_device_code_exchange_failed',skip,async t=>{
  const {signin}=await setup(t,{mode:'exchange',waitMs:200});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.code,DEVICE_CODE);
  const ended=await waitFor(()=>{const f=signin.get(flow.flowId);return f.status==='failed'&&f;});
  assert.equal(ended.reasonCode,'codex_device_code_exchange_failed');
});

test('the same sign-in works with the plain-text output as with the colored output',skip,async t=>{
  const {signin}=await setup(t,{color:false});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.url,'https://auth.openai.com/codex/device');
  assert.equal(flow.code,DEVICE_CODE);
  await waitFor(()=>signin.get(flow.flowId).status==='complete');
});

test('the colored fixture has the exact byte shapes of the real CLI',()=>{
  const e='\u001b';
  assert.ok(DEVICE_TEXT_COLORED.includes(e+'[94mhttps://auth.openai.com/codex/device'+e+'[0m'));
  assert.ok(DEVICE_TEXT_COLORED.includes(e+'[90m(expires in 15 minutes)'+e+'[0m'));
  assert.ok(DEVICE_TEXT_COLORED.includes(e+'[94m'+DEVICE_CODE+e+'[0m'));
});

// B: only the one verification link is shown in device mode.
test('a link printed before the verification link is ignored',skip,async t=>{
  const {signin}=await setup(t,{helpLink:true});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.url,'https://auth.openai.com/codex/device');
});
test('only the exact verification link is accepted in device mode',()=>{
  const ok=u=>deviceVerificationLink(new URL(u));
  assert.equal(ok('https://auth.openai.com/codex/device'),'https://auth.openai.com/codex/device');
  for(const bad of ['https://auth.openai.com/oauth/authorize','https://chatgpt.com/codex/device','https://auth0.openai.com/codex/device','http://auth.openai.com/codex/device',
    'https://auth.openai.com:8443/codex/device','https://user@auth.openai.com/codex/device','https://auth.openai.com/codex/device/x','https://auth.openai.com/codex/device?a=1','https://auth.openai.com/codex/device#x','https://auth.openai.com.evil.test/codex/device'])
    assert.equal(ok(bad),null,bad);
});

// D: expiry.
test('the code leaves the view and the flow ends as timed_out when it expires',skip,async t=>{
  const {signin}=await setup(t,{waitMs:6000},{},{deviceCodeLifeMs:400});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.code,DEVICE_CODE);
  const ended=await waitFor(()=>{const f=signin.get(flow.flowId);return f.status!=='awaiting_browser'&&f;});
  assert.equal(ended.status,'timed_out');
  assert.equal(ended.reasonCode,'codex_device_code_expired');
  assert.equal(ended.code,undefined);
  assert.equal(ended.url,undefined);
});
test('the CLI saying the code expired ends as timed_out too',skip,async t=>{
  const {signin}=await setup(t,{mode:'expired',waitMs:200});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  const ended=await waitFor(()=>{const f=signin.get(flow.flowId);return f.status!=='awaiting_browser'&&f;});
  assert.equal(ended.status,'timed_out');
  assert.equal(ended.reasonCode,'codex_device_code_expired');
});
test('a slow start does not use up the provider deadline before the code is ready',skip,async t=>{
  const {home,fake}=await setup(t,{readyDelayMs:700,waitMs:100});
  const handle=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:fake.bin,completionTimeoutMs:400});
  const result=await handle.waitForCompletion();
  assert.equal(result.status,'complete');
});

test('a failure with no refusal text is not reported as a device code problem',skip,async t=>{
  const {home,signin}=await setup(t);
  const bin=join(home,'plain');
  const {writeFile}=await import('node:fs/promises');
  await writeFile(bin,'#!'+process.execPath+'\nconsole.error("something else broke");process.exit(1);\n',{mode:0o700});
  const other=createSignin({adapters:async()=>[{spec:CODEX_HARNESS}],backend:()=>({}),onComplete:async()=>{},
    startProvider:(s,{onHandle,method})=>startProviderGenerationAuth(s,{home,providerBin:bin,onHandle,method})});
  t.after(()=>other.close());
  await other.begin(CODEX_HARNESS.harness_id,ID);
  const flow=await waitFor(()=>{const f=other.get(ID);return f.status==='failed'&&f;});
  assert.notEqual(flow.reasonCode,'codex_device_code_unavailable');
});

test('method browser starts the loopback flow with the paste field; the CLI is not given --device-auth',skip,async t=>{
  const home=await mkdtemp(join(tmpdir(),'codex-device-browser-'));
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  const fake=await fakeCodex(home,await freePort());
  const signin=createSignin({adapters:async()=>[{spec:CODEX_HARNESS}],backend:()=>({}),onComplete:async()=>{},
    startProvider:(s,{onHandle,method})=>startProviderGenerationAuth(s,{home,providerBin:fake.bin,onHandle,method})});
  t.after(()=>signin.close());
  const flow=await signin.post(['signin',CODEX_HARNESS.harness_id],{method:'browser'});
  assert.equal(flow.status,'awaiting_browser');
  assert.equal(flow.redirectEntry,true);
});

test('signin.start method: only Codex takes browser, only device or browser are known',skip,async t=>{
  const {signin,starts}=await setup(t);
  for(const target of ['docker','github','claude','claude-lending'])
    await assert.rejects(signin.post(['signin',target],{method:'browser'}),{code:'invalid_request',status:400},target);
  await assert.rejects(signin.post(['signin','codex'],{method:'carrier-pigeon'}),{code:'invalid_request',status:400});
  await assert.rejects(signin.post(['signin','codex'],{method:7}),{code:'invalid_request',status:400});
  await assert.rejects(signin.post(['signin','codex'],{method:'browser',requestId:'not-an-id'}),{code:'invalid_request',status:400});
  assert.deepEqual(starts,[],'nothing started for a refused method');
  const flow=await signin.post(['signin','codex'],{method:'device'});
  assert.equal(flow.code,DEVICE_CODE);
  assert.deepEqual(starts,['device']);
});

// A: terminal hyperlinks (OSC 8) and escapes split across chunks.
const E='\u001b',BEL='\u0007',LINK='https://auth.openai.com/codex/device';
const osc=(url,label,end)=>`${E}]8;;${url}${end}${label}${E}]8;;${end}`;
const steps=(linkPart,codePart)=>`Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   ${linkPart}\n\n2. Enter this one-time code ${E}[90m(expires in 15 minutes)${E}[0m\n   ${codePart}\n`;
const FORMS={
  'OSC 8 ended by BEL':steps(osc(LINK,LINK,BEL),osc('https://auth.openai.com/codex/device',DEVICE_CODE,BEL)),
  'OSC 8 ended by ESC backslash':steps(osc(LINK,LINK,E+'\\'),osc(LINK,DEVICE_CODE,E+'\\')),
  'OSC 8 around a label that is not the link':steps(osc(LINK,'Open sign-in page',BEL),`${E}[94m${DEVICE_CODE}${E}[0m`),
  'a bare two-byte escape before the code':steps(LINK,`${E}7${DEVICE_CODE}${E}8`),
};
for(const [name,raw] of Object.entries(FORMS))
  test('device sign-in reads the link and the code through '+name,skip,async t=>{
    const {signin}=await setup(t,{raw});
    const flow=await signin.start(CODEX_HARNESS.harness_id);
    assert.equal(flow.url,LINK);
    assert.equal(flow.code,DEVICE_CODE);
    await waitFor(()=>signin.get(flow.flowId).status==='complete');
  });
const splitsOf=(raw,needle)=>{const i=raw.indexOf(needle);return [i+1,i+2,i+3];};
for(const [name,raw,needle] of [
  ['inside the OSC 8 opener',FORMS['OSC 8 ended by BEL'],`${E}]8;;https`],
  ['inside the OSC 8 URL',FORMS['OSC 8 ended by BEL'],'auth.openai.com/codex'],
  ['between ESC and backslash of the terminator',FORMS['OSC 8 ended by ESC backslash'],`${E}\\`],
  ['inside a CSI sequence',FORMS['OSC 8 ended by BEL'],`${E}[90m`],
  ['inside the code',FORMS['OSC 8 ended by BEL'],DEVICE_CODE]])
  test('a chunk split '+name+' still gives the link and the code',skip,async t=>{
    const {signin}=await setup(t,{raw,splitAt:name==='inside the code'?[raw.indexOf(DEVICE_CODE)+2]:splitsOf(raw,needle).filter(i=>i>0)});
    const flow=await signin.start(CODEX_HARNESS.harness_id);
    assert.equal(flow.url,LINK);
    assert.equal(flow.code,DEVICE_CODE);
  });
test('a link in an OSC 8 sequence to another host is not accepted',skip,async t=>{
  const raw=steps(osc('https://evil.example/codex/device','https://auth.openai.com/codex/device-x',BEL),DEVICE_CODE);
  const {home,fake}=await setup(t,{raw,waitMs:50});
  const handle=startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:fake.bin});
  await assert.rejects(handle,/ended before returning a login URL/);
});
test('the flow view carries the code expiry only while the code is shown',skip,async t=>{
  const {signin}=await setup(t,{waitMs:6000},{},{deviceCodeLifeMs:600});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.ok(Number.isFinite(flow.expiresAt)&&Math.abs(flow.expiresAt-Date.now())<5000);
  const ended=await waitFor(()=>{const f=signin.get(flow.flowId);return f.status!=='awaiting_browser'&&f;});
  assert.equal(ended.expiresAt,undefined);
});

for (const [name, prefix] of [
  ['LF', '\u001b]broken\n'], ['CR', '\u001b]broken\r'],
  ['2048-byte bound', '\u001b]'+ 'x'.repeat(2049)],
]) test('an unterminated OSC recovers at '+name+' and parses later code and exact URL',skip,async t=>{
  const raw=prefix+'\n'+LINK+'\n'+DEVICE_CODE+'\n';
  const {signin}=await setup(t,{raw,waitMs:3000},{},{urlTimeoutMs:700});
  const flow=await signin.start(CODEX_HARNESS.harness_id);
  assert.equal(flow.code,DEVICE_CODE);
  assert.equal(flow.url,LINK);
});

test('OSC recovery drops only the opener at CR, LF and the UTF-8 byte bound',()=>{
  for(const tail of ['broken\rplain','broken\nplain','x'.repeat(2048),'é'.repeat(1024)])
    assert.equal(stripTerminalCodes(E+']'+tail),tail);
  assert.equal(stripTerminalCodes(E+']'+ 'x'.repeat(2048)+'visible'+BEL),'x'.repeat(2048)+'visible'+BEL);
  assert.equal(stripTerminalCodes(E+']'+'x'.repeat(2047)),'','incomplete bounded body stays hidden');
});
