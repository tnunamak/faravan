import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureMacSession} from '../lib/v1/macos-session.mjs';

test('G08 manual macOS launch registers crash recovery without enabling login startup',async t=>{
  const home=await mkdtemp(join(tmpdir(),'faravan-session-')),calls=[];
  t.after(()=>rm(home,{recursive:true,force:true}));
  await ensureMacSession({home,environment:{},uid:501,launcher:'/Applications/Faravan.app/Contents/MacOS/faravan-launch',label:'test.session',run:async(command,args)=>{
    calls.push([command,...args]);return {code:args[0]==='print'?113:0};
  }});
  assert.deepEqual(calls.map(row=>row[1]),['print','bootstrap','kickstart']);
  const plist=await readFile(calls[1][3],'utf8');
  assert.ok(calls[1][3].startsWith(join(home,'v1')));
  assert.match(plist,/<string>--managed<\/string>/);
  assert.match(plist,/<key>SuccessfulExit<\/key><false\/>/);
  assert.doesNotMatch(calls[1][3],/LaunchAgents/);
  assert.ok(plist.includes('<key>FARAVAN_HOME</key><string>'+home+'</string>'));
  assert.doesNotMatch(plist,/CODEX_HOME|CLAUDE_CONFIG_DIR/);
});
test('G08 reopening a managed session does not kill its live owner',async()=>{
  const calls=[];
  await ensureMacSession({home:'/unused',environment:{},uid:501,launcher:'/Applications/Faravan.app/Contents/MacOS/faravan-launch',label:'test.session',run:async(command,args)=>{calls.push(args);return {code:0};}});
  assert.deepEqual(calls,[['print','gui/501/test.session'],['kickstart','gui/501/test.session']]);
});

test('managed launch preserves only the selected profile and the session home wins',async t=>{
  const home=await mkdtemp(join(tmpdir(),'faravan-profile-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const calls=[],environment={
    FARAVAN_HOME:'/wrong/profile',CODEX_HOME:'/owned/codex & <tools>',
    CLAUDE_CONFIG_DIR:'/owned/claude "profile"',
    HOME:'/forbidden/home',USERPROFILE:'/forbidden/user',XDG_CONFIG_HOME:'/forbidden/xdg',
    PATH:'/forbidden/path',UNRELATED:'not-copied',
  };
  await ensureMacSession({home,environment,uid:501,launcher:'/Applications/Faravan.app/Contents/MacOS/faravan-launch',
    label:'test.profile.resident',run:async(command,args)=>{calls.push(args);return {code:args[0]==='print'?113:0};}});
  const plist=await readFile(calls[1][2],'utf8');
  assert.ok(plist.includes('<key>FARAVAN_HOME</key><string>'+home+'</string>'));
  assert.ok(plist.includes('<key>CODEX_HOME</key><string>/owned/codex &amp; &lt;tools&gt;</string>'));
  assert.ok(plist.includes('<key>CLAUDE_CONFIG_DIR</key><string>/owned/claude &quot;profile&quot;</string>'));
  assert.doesNotMatch(plist,/wrong|forbidden|UNRELATED|not-copied|<key>HOME<\/key>|USERPROFILE|XDG_|<key>PATH<\/key>/);
  assert.match(plist,/<string>--managed<\/string>/);
  assert.deepEqual(calls.map(args=>args[0]),['print','bootstrap','kickstart']);
  assert.equal(environment.FARAVAN_HOME,'/wrong/profile');
});

test('unsafe session profile is rejected before launchctl or writes',async()=>{
  const calls=[],run=async(...args)=>{calls.push(args);return {code:0};};
  for(const home of ['', 'relative', '/owned/\nprofile']){
    await assert.rejects(ensureMacSession({home,environment:{},uid:501,launcher:'/Applications/launch',run}),/home|absolute|unsafe/);
  }
  await assert.rejects(ensureMacSession({home:'/owned',environment:{CODEX_HOME:'/bad/\u0000'},uid:501,launcher:'/Applications/launch',run}),/CODEX_HOME/);
  assert.deepEqual(calls,[]);
});

test('Q4 P1-1 launchctl timeout and null exit are failures with recovery guidance', async t => {
  const {default: cp} = await import('node:child_process');
  const {syncBuiltinESMExports} = await import('node:module');
  const original = cp.execFile;
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  for (const error of [{code:null,signal:'SIGTERM',killed:true},{code:null}]) {
    cp.execFile = (_command,_args,_options,callback) => callback(error);
    syncBuiltinESMExports();
    await assert.rejects(ensureMacSession({home:'/unused',environment:{},uid:501,launcher:'/Applications/launch'}),
      /session.*try again/i);
  }
});
