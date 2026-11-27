import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMacAutostart, launchAgentPlist} from '../lib/v1/autostart.mjs';

async function fixture(t) {
  const userHome=await mkdtemp(join(tmpdir(),'spk-login-'));
  t.after(()=>rm(userHome,{recursive:true,force:true}));
  const launcher=join(userHome,'Apps & Tools','Faravan.app/Contents/MacOS/faravan-launch');
  await mkdir(join(launcher,'..'),{recursive:true});await writeFile(launcher,'executable',{mode:0o755});
  const calls=[];let loaded=false;
  const options={environment:{},platform:'darwin',userHome,uid:501,launcher,run:async (cmd,args)=>{calls.push([cmd,...args]);
    if(args[0]==='print')return {code:loaded?0:113};
    if(args[0]==='bootstrap')loaded=true;
    if(args[0]==='bootout')loaded=false;
    return {code:0};}};
  return {userHome,launcher,calls,options,agent:createMacAutostart(options)};
}
test('login is opt-in, uses GUI launchd, escapes paths and keeps Quit quit',async t=>{
  const f=await fixture(t);
  assert.equal((await f.agent.status()).enabled,false);assert.deepEqual(f.calls,[]);
  const view=await f.agent.setEnabled(true);
  assert.equal(view.enabled,true);
  const xml=await readFile(join(f.userHome,'Library/LaunchAgents/com.faravan.agent.plist'),'utf8');
  assert.match(xml,/Apps &amp; Tools/);assert.match(xml,/<string>--background<\/string>/);
  assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);assert.match(xml,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/>/);
  assert.match(xml,/<string>\/dev\/null<\/string>/);
  assert.ok(f.calls.some(c=>c[1]==='bootstrap'&&c[2]==='gui/501'));
  await f.agent.setEnabled(false);
  assert.ok(f.calls.some(c=>c[1]==='disable'&&c[2]==='gui/501/com.faravan.agent'));
  assert.equal(f.calls.at(-1)[1],'disable','off does not terminate the running app');
  assert.equal((await f.agent.status()).enabled,false);
});
test('preview login item uses its channel LaunchAgent label', async t => {
  const f = await fixture(t), channel = { launchAgentLabel: 'com.faravan.preview.canary.agent' };
  const preview = createMacAutostart({ ...f.options, channel });
  await preview.setEnabled(true);
  const plist = join(f.userHome, 'Library/LaunchAgents/com.faravan.preview.canary.agent.plist');
  assert.match(await readFile(plist, 'utf8'), /<string>com\.faravan\.preview\.canary\.agent<\/string>/);
  assert.ok(f.calls.some(call => call.at(-1) === 'gui/501/com.faravan.preview.canary.agent'));
});
test('relocation is reported and enable repairs the absolute path',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);
  const moved=f.launcher.replace('Apps & Tools','Moved Apps');
  await mkdir(join(moved,'..'),{recursive:true});await writeFile(moved,'x',{mode:0o755});
  const agent=createMacAutostart({...f.options,launcher:moved});
  assert.equal((await agent.status()).needsRepair,true);
  await agent.setEnabled(true);assert.equal((await agent.status()).needsRepair,false);
  assert.match(await readFile(join(f.userHome,'Library/LaunchAgents/com.faravan.agent.plist'),'utf8'),/Moved Apps/);
});
test('missing installed app cannot register a stale login item; off can always disable one',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);await rm(f.launcher);
  const view=await f.agent.status();assert.equal(view.available,false);
  await assert.rejects(f.agent.setEnabled(true),/installed Faravan.app/);
  await f.agent.setEnabled(false);assert.equal((await f.agent.status()).enabled,false);
  assert.match(await readFile(join(f.userHome,'Library/LaunchAgents/com.faravan.agent.plist'),'utf8'),/<key>Disabled<\/key><true\/>/);
});
test('failed bootstrap rolls back file and does not report enabled',async t=>{
  const f=await fixture(t);
  const agent=createMacAutostart({...f.options,run:async(cmd,args)=>({code:args[0]==='bootstrap'?5:args[0]==='print'?113:0})});
  await assert.rejects(agent.setEnabled(true),/launchctl/);
  assert.equal((await f.agent.status()).enabled,false);
});
test('unsupported platforms have no effects; malformed input is rejected',async t=>{
  const f=await fixture(t);const agent=createMacAutostart({...f.options,platform:'linux'});
  assert.equal((await agent.status()).supported,false);
  await assert.rejects(agent.setEnabled(true),/macOS/);
  await assert.rejects(f.agent.setEnabled('yes'),/boolean/);
  assert.deepEqual(f.calls,[]);
  assert.throws(()=>launchAgentPlist('relative'),/absolute/);
});

test('the authenticated app exposes login choice without enabling lending',async t=>{
  const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
  let enabled=false;const changes=[];
  const autostart={status:async()=>({supported:true,available:true,enabled,needsRepair:false}),setEnabled:async value=>{changes.push(value);enabled=value;return autostart.status();}};
  const f=await appFixture(t),{app}=await f.start('mac-login',{platform:'darwin',autostart});
  const before=await api(app,'/api/lending');
  await api(app,'/api/desktop/autostart',{method:'POST',body:{enabled:true},token:null,status:401});
  await api(app,'/api/desktop/autostart',{method:'POST',body:{enabled:true,extra:1},status:400});
  assert.deepEqual(changes,[]);
  await api(app,'/api/desktop/autostart',{method:'POST',body:{enabled:true}});
  assert.equal((await api(app,'/api/status')).desktop.autostart.enabled,true);
  assert.equal((await api(app,'/api/lending')).enabled,before.enabled);
  await api(app,'/api/desktop/autostart',{method:'POST',body:{enabled:false}});
  const viaOps=await api(app,'/api/ops/desktop.autostart',{method:'POST',body:{enabled:true}});
  assert.equal(viaOps.enabled,true);
  assert.deepEqual(changes,[true,false,true]);
});


test('off/on while launchd still owns the running app does not boot it out',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);await f.agent.setEnabled(false);
  const before=f.calls.length;await f.agent.setEnabled(true);
  assert.equal((await f.agent.status()).enabled,true);
  assert.ok(!f.calls.slice(before).some(c=>c[1]==='bootout'||c[1]==='bootstrap'),'the live launcher stays alive during preference changes');
});


test('a disabled login item stays off after moving the app',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);await f.agent.setEnabled(false);
  const moved=f.launcher.replace('Apps & Tools','Moved Apps');
  await mkdir(join(moved,'..'),{recursive:true});await writeFile(moved,'x',{mode:0o755});
  const state=await createMacAutostart({...f.options,launcher:moved}).status();
  assert.equal(state.enabled,false);assert.equal(state.needsRepair,false);
});
test('repairing an existing loaded login item never bootouts its own app',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);
  const plist=join(f.userHome,'Library/LaunchAgents/com.faravan.agent.plist');
  await writeFile(plist,(await readFile(plist,'utf8')).replace('<dict>','<dict><!-- previous template -->'));
  const before=f.calls.length;await f.agent.setEnabled(true);
  assert.ok(!f.calls.slice(before).some(c=>c[1]==='bootout'||c[1]==='bootstrap'));
  assert.equal((await f.agent.status()).needsRepair,false);
});
test('translocated apps cannot register a temporary login path',async t=>{
  const f=await fixture(t);
  const launcher=join(f.userHome,'AppTranslocation/random/Faravan.app/Contents/MacOS/faravan-launch');
  await mkdir(join(launcher,'..'),{recursive:true});await writeFile(launcher,'x',{mode:0o755});
  const agent=createMacAutostart({...f.options,launcher});
  assert.equal((await agent.status()).available,false);
  await assert.rejects(agent.setEnabled(true),/Applications/);
});


test('failed re-enable restores both the disabled plist and the launchd choice',async t=>{
  const f=await fixture(t);await f.agent.setEnabled(true);await f.agent.setEnabled(false);
  const calls=[];const agent=createMacAutostart({...f.options,run:async(cmd,args)=>{calls.push(args);return {code:args[0]==='bootstrap'?5:args[0]==='print'?113:0};}});
  await assert.rejects(agent.setEnabled(true),/Login Items/);
  assert.equal((await agent.status()).enabled,false);
  assert.ok(calls.some(args=>args[0]==='disable'));
});

test('profile plist carries only explicit selectors and leaves defaults alone',()=>{
  const launcher='/Applications/Faravan.app/Contents/MacOS/faravan-launch';
  assert.doesNotMatch(launchAgentPlist(launcher,'test.profile',{}),/EnvironmentVariables/);
  assert.doesNotMatch(launchAgentPlist(launcher,'test.profile',{FARAVAN_HOME:'',CODEX_HOME:'',CLAUDE_CONFIG_DIR:''}),/EnvironmentVariables/);
  const environment={FARAVAN_HOME:'/owned/faravan',CODEX_HOME:'/owned/codex',CLAUDE_CONFIG_DIR:"/owned/claude's <&> profile"};
  Object.defineProperty(environment,'HOME',{get(){throw new Error('must not read HOME');}});
  Object.defineProperty(environment,'UNRELATED',{get(){throw new Error('must not read unrelated environment');}});
  const plist=launchAgentPlist(launcher,'test.profile',environment);
  assert.equal(plist.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/)[1],
    '<key>FARAVAN_HOME</key><string>/owned/faravan</string><key>CODEX_HOME</key><string>/owned/codex</string><key>CLAUDE_CONFIG_DIR</key><string>/owned/claude&apos;s &lt;&amp;&gt; profile</string>');
  for(const value of ['relative','/bad/\npath','/bad/\u0000','/bad/\u007f','/bad/\ud800','/bad/\uffff',42]){
    assert.throws(()=>launchAgentPlist(launcher,'test.profile',{CODEX_HOME:value}),/CODEX_HOME/);
  }
});

test('selected profile participates in login status and repair without replacing a live owner',async t=>{
  const f=await fixture(t);
  await f.agent.setEnabled(true);
  const environment={FARAVAN_HOME:'/owned/faravan',CODEX_HOME:'/owned/codex',CLAUDE_CONFIG_DIR:'/owned/claude',
    HOME:'/forbidden/home',USERPROFILE:'/forbidden/user',XDG_CONFIG_HOME:'/forbidden/xdg',PATH:'/forbidden/path'};
  const agent=createMacAutostart({...f.options,environment});
  assert.equal((await agent.status()).needsRepair,true);
  const before=f.calls.length;
  await agent.setEnabled(true);
  const plist=await readFile(join(f.userHome,'Library/LaunchAgents/com.faravan.agent.plist'),'utf8');
  for(const key of ['FARAVAN_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']){
    assert.ok(plist.includes('<key>'+key+'</key><string>'+environment[key]+'</string>'));
  }
  assert.doesNotMatch(plist,/forbidden|<key>HOME<\/key>|USERPROFILE|XDG_|<key>PATH<\/key>|--managed/);
  assert.equal((await agent.status()).needsRepair,false);
  assert.deepEqual(f.calls.slice(before).map(row=>row[1]),['enable','print']);
  assert.equal((await f.agent.status()).needsRepair,true,'default selection detects the different saved environment');
  await agent.setEnabled(false);
  assert.equal((await agent.status()).enabled,false);
  assert.equal((await f.agent.status()).needsRepair,false,'disabled preference remains disabled for repair comparisons');
});
