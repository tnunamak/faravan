import './helpers/no-browser.mjs';
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

// Every host-query command, including the macOS ctypes helper, is intercepted.
// Only the Bash/Python runtimes and our own inert process metadata are real.
const script = fileURLToPath(new URL('../packaging/check-visible-launch.sh', import.meta.url));
const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000}).stdout?.trim();
assert.ok(python, 'Python 3 must already be installed; never install it here');
const bash = spawnSync('which', ['bash'], {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000}).stdout?.trim();
assert.ok(bash, 'Bash must already be installed');
let root, bin, home, app, tray;
const children = [];
const stub = String.raw`
const {basename} = require('node:path');
const {appendFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const name = basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
const scenario = env.STUB_SCENARIO;
if (env.FARAVAN_NO_BROWSER !== '1' || env.FARAVAN_NO_BROWSER !== '1') process.exit(92);
appendFileSync(env.STUB_LOG, JSON.stringify({name,args})+'\n');
let propertyReply=false;
const emit = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify({data:propertyReply?[{type:'fixture-property',data:value[0]}]:value}));
const app = Number(env.STUB_APP), tray = Number(env.STUB_TRAY), uid = process.getuid();
if (name === 'python3') {
  if (args[0] === '-') {
    const p=spawnSync(env.STUB_PYTHON,args,{stdio:'inherit',timeout:15000}); process.exit(p.status ?? 91);
  }
  if (args[0] !== '-c' || !args[1].includes('# FARAVAN_CG_WINDOW_METADATA_V1')) process.exit(90);
  if (scenario === 'mac-denied') process.exit(1);
  if (scenario === 'mac-malformed') {emit('bad json'); process.exit(0);}
  if (scenario === 'mac-no-gui') {emit(JSON.stringify({gui:false})); process.exit(0);}
  const window = {kCGWindowNumber:17,kCGWindowLayer:25,kCGWindowIsOnscreen:true,kCGWindowAlpha:1,kCGWindowBounds:{X:500,Y:0,Width:24,Height:24}};
  if (scenario === 'mac-transparent') window.kCGWindowAlpha=0;
  if (scenario === 'mac-redacted') delete window.kCGWindowBounds;
  if (scenario === 'mac-nonnumeric') window.kCGWindowBounds.Width='24';
  if (scenario === 'mac-other-layer') window.kCGWindowLayer=0;

  if (scenario === 'mac-partly-redacted') {emit(JSON.stringify({gui:true,status_level:25,windows:[window,{kCGWindowNumber:18}]})); process.exit(0);}
  if (scenario.startsWith('mac-second-')) {
    const second = scenario === 'mac-second-null' ? null : {kCGWindowNumber:18,kCGWindowLayer:scenario === 'mac-second-other-layer' ? 0 : scenario === 'mac-second-string-layer' ? '25' : true};
    emit(JSON.stringify({gui:true,status_level:25,windows:[window,second]})); process.exit(0);
  }
  const windows = scenario === 'mac-empty' ? [] : scenario === 'mac-ambiguous' ? [window,window] : [window];
  emit(JSON.stringify({gui:true,status_level:25,windows})); process.exit(0);
}
if (name === 'uname') {emit(scenario.startsWith('mac-') ? 'Darwin\n' : 'Linux\n'); process.exit(0);}
if (name === 'systemctl') {
  const role=args.some(a=>a.includes('preview-tray-'))?'tray':'app';
  emit(args.includes('list-units') ? 'faravan-preview-'+role+'-fixture.service loaded active running\n' : 'MainPID='+(role==='tray'?tray:app)+'\nActiveState=active\n'); process.exit(0);
}
if (name === 'loginctl') {emit('Active=yes\nType=wayland\nUser='+uid+'\nRemote=no\n'); process.exit(0);}
if (name === 'curl') {emit('200'); process.exit(0);}
if (name === 'lsappinfo') {emit('pid=700\n'); process.exit(0);}
if (name === 'ps') {
  if (scenario.startsWith('mac-')) {
    const parent=scenario==='mac-foreign-tray'?1:701;
    emit('700 1 '+uid+' /Applications/Faravan.app/Contents/MacOS/faravan-launch\n701 700 '+uid+' /Applications/Faravan.app/Contents/Resources/faravan/runtime/bin/node\n702 '+parent+' '+uid+' /Applications/Faravan.app/Contents/MacOS/faravan-tray\n');
  } else emit('999 '+uid+' /usr/bin/gnome-shell\n');
  process.exit(0);
}
if (name === 'busctl') {
  if (!args.includes('--auto-start=no') || !args.includes('--allow-interactive-authorization=no')) process.exit(93);

  if (scenario === 'unreadable-root-owner' && args.includes('GetConnectionUnixProcessID') && args.at(-1) === ':1.88') process.exit(1);
  if (scenario === 'unreadable-target-name' && args.includes('/second') && args.at(-1) === 'Name') process.exit(1);
  if (scenario === 'unreadable-target-role' && args.includes('/secondroot') && args.includes('GetRoleName')) process.exit(1);
  if (scenario === 'atspi-denied' && args.some(a=>a.startsWith('--address='))) process.exit(1);
  const i=args.findIndex(a=>a==='call'||a==='get-property');
  let [action,service,path,iface,method,...rest]=args.slice(i);
  if (action !== 'call') process.exit(96);
  if (iface==='org.freedesktop.DBus.Properties'&&method==='Get') {propertyReply=true; method=rest.at(-1);}
  if (scenario==='permission-denied') process.exit(1);
  if (method==='RegisteredStatusNotifierItems') {emit(scenario==='bad-watcher'?[17]:[[scenario==='foreign-item'?':1.43/StatusNotifierItem':scenario==='service-only'?':1.42':':1.42/StatusNotifierItem']]); process.exit(0);}
  if (method==='IsStatusNotifierHostRegistered') {emit([scenario!=='host-missing']); process.exit(0);}
  if (method==='GetConnectionUnixProcessID') {emit([rest.at(-1)===':1.43'?998:rest.at(-1)===':1.77'&&scenario==='panel-proxy'?999:tray]); process.exit(0);}
  if (method==='GetExtensionInfo') {
    if (service!=='org.gnome.Shell'||path!=='/org/gnome/Shell') process.exit(97);
    emit(scenario==='gnome-flat-dict'?[['state',{type:'d',data:1}]]:[{state:{type:'d',data:scenario==='gnome-disabled'?2:1}}]); process.exit(0);
  }
  if (method==='Status') {emit([scenario==='passive'?'Passive':'Active']); process.exit(0);}
  if (method==='Title') {emit([scenario==='no-title'?'':'Faravan private title']); process.exit(0);}
  if (method==='IconName') {emit([['no-icon','pixmap','bad-pixmap'].includes(scenario)?'':'faravan']); process.exit(0);}
  if (method==='IconPixmap') {emit(scenario==='pixmap'?[[[1,1,[1,2,3,4]]]]:scenario==='bad-pixmap'?[[[1,1,[1,2,3]]]]:[[]]); process.exit(0);}
  if (method==='NameHasOwner') {emit([scenario!=='no-atspi']); process.exit(0);}
  if (method==='GetAddress') process.exit(98); // This seemingly read-only method can launch a daemon.

  if (method==='GetChildren') {
    if (scenario==='unreadable-root-owner' && path==='/org/a11y/atspi/accessible/root') {emit([[[':1.77','/panel'],[':1.88','/other']]]); process.exit(0);}
    if (scenario==='unreadable-target-role' && path==='/org/a11y/atspi/accessible/root') {emit([[[':1.77','/panel'],[':1.77','/secondroot']]]); process.exit(0);}
    if (scenario==='unreadable-target-name' && path==='/panel') {emit([[[':1.77','/item'],[':1.77','/second']]]); process.exit(0);}

    emit(path==='/org/a11y/atspi/accessible/root'?[[[':1.77','/panel']]]:path==='/panel'?[[[':1.77','/item']]]:[[]]); process.exit(0);
  }
  if (method==='GetRoleName') {emit([path==='/panel'?'panel':'push button']); process.exit(0);}
  if (method==='Name') {emit([path==='/panel'?'Panel':scenario==='title-mismatch'?'Other title':'Faravan private title']); process.exit(0);}
  if (method==='GetState') {emit([[scenario==='not-showing'?1073741824:1107296256,0]]); process.exit(0);}
  if (method==='GetExtents') {emit([[500,0,scenario==='zero-extents'?0:24,24]]); process.exit(0);}
  process.exit(94);
}
// Any unplanned command is fatal. No real desktop tool is reachable on PATH.
process.exit(95);
`;

before(async () => {
  root=mkdtempSync(join(tmpdir(),'faravan-drawn-'));
  bin=join(root,'bin'); home=join(root,'state'); mkdirSync(bin); mkdirSync(home);
  for (const name of ['python3','uname','systemctl','loginctl','busctl','ps','lsappinfo','curl']) {
    const path=join(bin,name); writeFileSync(path,'#!'+process.execPath+'\n'+stub); chmodSync(path,0o700);
  }
  async function inert() {
    const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n"); setInterval(()=>{}, 1000)'],{env:{...process.env,FARAVAN_HOME:home,WAYLAND_DISPLAY:'stub-wayland',DBUS_SESSION_BUS_ADDRESS:'unix:path=/stub/session',FARAVAN_NO_BROWSER:'1'},stdio:['ignore','pipe','ignore']});
    children.push(child); await once(child.stdout,'data'); return child;
  }
  app=await inert(); tray=await inert();
});
after(async () => {
  for (const child of children) {child.kill(); await once(child,'exit');}
  if (root) rmSync(root,{recursive:true,force:true});
});

function check(scenario,extra={}) {
  const log=join(root,scenario+'.log'); writeFileSync(log,'');
  const env={PATH:bin,HOME:root,LANG:'C',FARAVAN_NO_BROWSER:'1',STUB_SCENARIO:scenario,STUB_LOG:log,STUB_PYTHON:python,STUB_APP:String(app.pid),STUB_TRAY:String(tray.pid),XDG_SESSION_ID:'stub',XDG_CURRENT_DESKTOP:'GNOME',WAYLAND_DISPLAY:'stub-wayland',DBUS_SESSION_BUS_ADDRESS:'unix:path=/stub/session',ATSPI_BUS_ADDRESS:'unix:path=/stub/a11y',...extra};
  const result=spawnSync(bash,[script,'--home',extra.REVIEW_HOME ?? home,'--url','http://127.0.0.1:43123','--json'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000,maxBuffer:4*1024*1024});
  assert.equal(result.status,1,result.stderr);
  const report=JSON.parse(result.stdout);
  const rows=Object.fromEntries(report.checks.map(r=>[r.name,r]));
  for (const r of report.checks) {
    assert.ok(['PASS','FAIL','UNKNOWN'].includes(r.status));
    assert.ok(r.command.length>0);
  }
  assert.equal(report.accepted,false);
  assert.equal(rows.compositor_pixels.status,'UNKNOWN');
  assert.ok(!result.stdout.includes('Faravan private title'));
  const calls=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(!calls.some(c=>c.args.includes('GetAddress')),'never invoke the accessibility bus launcher');
  return {rows,calls,report,env};
}


test('R1 command fields must omit unselected ATSPI environment values and outside-home paths',()=>{
  const sentinel='unix:path=/outside-state-home/PRIVATE_ATSPI_TOKEN_SENTINEL';
  const {rows,calls,env}=check('linux-pass',{ATSPI_BUS_ADDRESS:sentinel});
  assert.equal(rows.drawn_visibility.status,'PASS');
  assert.ok(!JSON.stringify(rows).includes(sentinel),'unselected ATSPI_BUS_ADDRESS must not leak through command');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_ATSPI_TOKEN_SENTINEL'));
  assert.ok(calls.some(c=>c.args.includes('--address='+sentinel)),'redaction must not change executed address');
  const text=spawnSync(bash,[script,'--home',home],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000,maxBuffer:4*1024*1024});
  assert.equal(text.status,1,text.stderr);
  assert.ok(!text.stdout.includes('PRIVATE_ATSPI_TOKEN_SENTINEL'),'human-readable rows must also redact the address');
});
test('R2 macOS visibility for an unrelated never-started home cannot PASS',()=>{
  const {rows}=check('mac-pass',{REVIEW_HOME:join(root,'never-started-home')});
  assert.equal(rows.isolated_home.status,'UNKNOWN');
  assert.equal(rows.menu_bar_item.status,'PASS');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('R3a incomplete root owner lookup cannot certify unique AT-SPI item',()=>{
  const {rows,calls}=check('unreadable-root-owner');
  assert.ok(calls.some(c=>c.args.includes('GetConnectionUnixProcessID') && c.args.at(-1)===':1.88'));
  assert.equal(rows.tray_accessibility.status,'UNKNOWN');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('R3b unreadable target Name cannot certify unique AT-SPI item',()=>{
  const {rows,calls}=check('unreadable-target-name');
  assert.ok(calls.some(c=>c.args.includes('/second') && c.args.at(-1)==='Name'));
  assert.equal(rows.tray_accessibility.status,'UNKNOWN');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('R4 partly redacted second macOS window cannot prove candidate uniqueness',()=>{
  const {rows}=check('mac-partly-redacted');
  assert.equal(rows.menu_bar_item.status,'UNKNOWN');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('R1 failed AT-SPI reads also omit the address',()=>{
  const {rows}=check('atspi-denied',{ATSPI_BUS_ADDRESS:'unix:path=/outside-state-home/PRIVATE_ATSPI_ERROR_SENTINEL'});
  assert.equal(rows.tray_accessibility.status,'UNKNOWN');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_ATSPI_ERROR_SENTINEL'));
});
test('R3 unreadable target role makes uniqueness incomplete',()=>{
  const {rows,calls}=check('unreadable-target-role');
  assert.ok(calls.some(c=>c.args.includes('/secondroot') && c.args.includes('GetRoleName')));
  assert.equal(rows.tray_accessibility.status,'UNKNOWN');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
for (const scenario of ['mac-second-null','mac-second-string-layer','mac-second-bool-layer']) test('R4 unclassified second window '+scenario,()=>{
  assert.equal(check(scenario).rows.menu_bar_item.status,'UNKNOWN');
});
test('R4 positively non-status second window does not block the narrower observed-window row',()=>{
  const {rows}=check('mac-second-other-layer');
  assert.equal(rows.menu_bar_item.status,'PASS');
  assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('C1 no Python on PATH returns runtime UNKNOWN without executing a host query',()=>{
  const env={PATH:join(root,'empty-path'),FARAVAN_NO_BROWSER:'1'};
  const result=spawnSync(bash,[script,'--home',home,'--json'],{env,encoding:'utf8',timeout:2000,stdio:['ignore','pipe','pipe']});
  assert.equal(result.status,1);
  const report=JSON.parse(result.stdout);
  assert.equal(report.accepted,false);
  assert.deepEqual(report.checks.map(r=>[r.name,r.status]),[['runtime','UNKNOWN']]);
  assert.equal(result.stderr,'');
});
