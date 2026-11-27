import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,existsSync,rmSync,mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
const setup=(t,extra={})=>{const dir=mkdtempSync(join(tmpdir(),'posthog-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,base:dir,version:'1.2.3',env:{},transport:async()=>({status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}),...extra};};
test('new notice gates default ON, persisted UUID is shared and reset/OFF replace it',async t=>{
 const options=setup(t);const tel=createTelemetry(options);
 assert.equal(tel.bootstrap().consent,'off');assert.equal(tel.bootstrap().noticePending,true);
 tel.markNoticeShown();const a=tel.bootstrap();assert.equal(a.consent,'on');assert.match(a.installId,/^[0-9a-f-]{36}$/);
 assert.equal(statSync(join(options.dir,'install.json')).mode&0o777,0o600);
 const other=createTelemetry(options);assert.equal(other.bootstrap().installId,a.installId);
 tel.resetIdentity();assert.notEqual(tel.bootstrap().installId,a.installId);
 tel.restrict();assert.equal(other.bootstrap().installId,null);assert.equal(existsSync(join(options.dir,'install.json')),false);
 tel.choose({level:'on'});assert.notEqual(tel.bootstrap().installId,a.installId);
 assert.equal(tel.bootstrap({headers:{'sec-gpc':'1'}}).consent,'off');
 await tel.close();await other.close();
});
test('old choices require new notice, preserve OFF, and discard old queues',async t=>{
 for(const level of ['counts','diagnostics','off']){
  const options=setup(t);writeFileSync(join(options.dir,'policy.json'),JSON.stringify({version:1,level,region:'US',generation:8,noticeShownAt:1,decidedAt:1}));
  const tel=createTelemetry(options);assert.equal(tel.bootstrap().consent,'off');assert.equal(tel.bootstrap().noticePending,true);
  tel.markNoticeShown();assert.equal(tel.bootstrap().consent,level==='off'?'off':'on');assert.equal(tel.status().allowance,level!=='off');await tel.close();
 }
});
test('unreadable policy, environment and build OFF fail closed',async t=>{
 for(const extra of [{env:{FARAVAN_NO_TELEMETRY:'1'}},{enabled:false},{bad:true}]){
  const options=setup(t,extra);if(extra.bad)writeFileSync(join(options.dir,'policy.json'),'broken');
  const tel=createTelemetry(options);if(!extra.bad)tel.markNoticeShown();assert.equal(tel.bootstrap().consent,'off');await tel.close();
 }
});

test('an interrupted OFF purge remains OFF and finishes on restart',async t=>{
 const options=setup(t);const tel=createTelemetry(options);tel.markNoticeShown();const id=tel.bootstrap().installId;
 const inbox=join(options.dir,'inbox');mkdirSync(inbox);writeFileSync(join(inbox,'private.json'),'{}');chmodSync(inbox,0);
 assert.throws(()=>tel.restrict());assert.equal(tel.bootstrap().consent,'off');assert.equal(existsSync(join(options.dir,'purge-pending.json')),true);
 chmodSync(inbox,0o700);const restarted=createTelemetry(options);assert.equal(restarted.bootstrap().consent,'off');assert.equal(existsSync(join(options.dir,'install.json')),false);assert.equal(existsSync(inbox),false);
 restarted.choose({level:'on'});assert.notEqual(restarted.bootstrap().installId,id);await tel.close();await restarted.close();
});
test('rendering a notice cannot repair an unreadable policy or revive a lost OFF decision',async t=>{
 const options=setup(t);writeFileSync(join(options.dir,'policy.json'),'broken');const tel=createTelemetry(options);tel.markNoticeShown();assert.equal(tel.bootstrap().consent,'off');await tel.close();
});
for (const [action, apply] of [
 ['resetting the ID', tel => tel.resetIdentity()],
 ['disabling recordings', tel => tel.choose({recordings:false})],
]) test(`${action} preserves an unreadable report choice across reopen`, async t => {
 const options=setup(t), policy=join(options.dir,'policy.json');
 const tel=createTelemetry(options);
 await tel.choose({level:'on'});
 assert.ok(tel.bootstrap().installId);
 writeFileSync(policy,'broken');
 await apply(tel);
 await tel.markNoticeShown();
 assert.equal(tel.status().reason.kind,'policy_unreadable');
 assert.equal(readFileSync(policy,'utf8'),'broken');
 assert.equal(tel.bootstrap().installId,null);
 assert.equal(existsSync(join(options.dir,'install.json')),false);
 await tel.close();

 const reopened=createTelemetry(options);
 await reopened.markNoticeShown();
 assert.equal(reopened.bootstrap().consent,'off');
 await reopened.choose({level:'on'});
 assert.equal(reopened.bootstrap().consent,'on');
 await reopened.close();
});
test('compiled OFF cannot be overridden by runtime options and also stops edge producers',async t=>{
 const {spawnSync}=await import('node:child_process');const options=setup(t);
 const moduleUrl=new URL('../lib/v1/telemetry/index.mjs',import.meta.url).href;
 const source=`import {registerHooks} from 'node:module';
 registerHooks({load(url,context,next){const loaded=next(url,context);if(url.endsWith('/telemetry/contract.mjs'))return {...loaded,source:String(loaded.source).replace('export const TELEMETRY_ENABLED = true;','export const TELEMETRY_ENABLED = false;')};return loaded;}});
 const {createTelemetry}=await import(${JSON.stringify(moduleUrl)});
 const {edgeGeneration}=await import(${JSON.stringify(new URL('../lib/v1/telemetry/consent.mjs',import.meta.url).href)});
 const tel=createTelemetry({dir:${JSON.stringify(options.dir)},base:${JSON.stringify(options.dir)},version:'1.2.3',enabled:true,env:{},transport:async()=>{throw new Error('unexpected network');}});
 tel.choose({level:'on'});tel.markNoticeShown();if(tel.bootstrap().consent!=='off')process.exit(2);if(edgeGeneration({dir:${JSON.stringify(options.dir)},env:{}})!==null)process.exit(3);await tel.flushNow();await tel.close();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
