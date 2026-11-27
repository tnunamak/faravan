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
const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8'}).stdout?.trim();
assert.ok(python, 'Python 3 must already be installed; never install it here');
const bash = spawnSync('which', ['bash'], {encoding:'utf8'}).stdout?.trim();
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
    const p=spawnSync(env.STUB_PYTHON,args,{stdio:'inherit'}); process.exit(p.status ?? 91);
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
  const result=spawnSync(bash,[script,'--home',home,'--url','http://127.0.0.1:43123','--json'],{env,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
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
  return {rows,calls};
}

test('Linux drawn PASS requires own properties, host and identity-bound AT-SPI semantics',()=>{
  const {rows,calls}=check('linux-pass');
  for(const name of ['tray_item_status','tray_item_icon','tray_item_title','tray_host','tray_accessibility','drawn_visibility']) assert.equal(rows[name].status,'PASS',name);
  assert.ok(calls.some(c=>c.name==='busctl'&&c.args.includes('IconPixmap')));
  assert.match(rows.drawn_visibility.detail,/Not compositor-pixel proof/);
});
test('registered host missing is FAIL, not drawn PASS',()=>{
  const {rows}=check('host-missing'); assert.equal(rows.tray_host.status,'FAIL'); assert.equal(rows.drawn_visibility.status,'FAIL');
});
test('permission-gated session bus is UNKNOWN',()=>{
  const {rows}=check('permission-denied'); assert.equal(rows.tray_registration.status,'UNKNOWN'); assert.equal(rows.tray_host.status,'UNKNOWN'); assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('registration and icon properties alone cannot establish drawn PASS',()=>{
  const {rows,calls}=check('no-atspi'); assert.equal(rows.tray_registration.status,'PASS'); assert.equal(rows.tray_item_icon.status,'PASS'); assert.equal(rows.drawn_visibility.status,'UNKNOWN'); assert.ok(!calls.some(c=>c.args.includes('GetChildren')));
});
test('title-only panel proxy is not target process identity',()=>{
  const {rows}=check('panel-proxy'); assert.equal(rows.tray_accessibility.status,'UNKNOWN'); assert.equal(rows.drawn_visibility.status,'UNKNOWN');
});
test('disabled GNOME integration is reported without suppressing independent host evidence',()=>{
  const {rows}=check('gnome-disabled'); assert.equal(rows.gnome_appindicator_extension.status,'FAIL'); assert.equal(rows.tray_host.status,'PASS');
});
test('GNOME extension state accepts busctl flat dictionary encoding',()=>assert.equal(check('gnome-flat-dict').rows.gnome_appindicator_extension.status,'PASS'));
for(const scenario of ['passive','no-icon','no-title','not-showing','zero-extents']) test('Linux negative '+scenario,()=>assert.equal(check(scenario).rows.drawn_visibility.status,'FAIL'));
for(const scenario of ['bad-pixmap','foreign-item','title-mismatch','bad-watcher']) test('Linux incomplete '+scenario,()=>assert.notEqual(check(scenario).rows.drawn_visibility.status,'PASS'));
test('valid ARGB32 pixmap is accepted when IconName is empty',()=>assert.equal(check('pixmap').rows.tray_item_icon.status,'PASS'));
test('service-only watcher entry uses the standard item object path',()=>{
  const {rows,calls}=check('service-only'); assert.equal(rows.drawn_visibility.status,'PASS');
  assert.ok(calls.some(c=>c.args.includes('Status')&&c.args.includes('/StatusNotifierItem')));
});
test('unbound graphical session never reads accessibility',()=>{
  const {rows,calls}=check('wrong-session',{WAYLAND_DISPLAY:'other-session'}); assert.equal(rows.drawn_visibility.status,'UNKNOWN');
  assert.ok(!calls.some(c=>c.args.some(a=>a.startsWith('--address='))));
});
for(const address of ['', 'unix:path=/stub/a11y;tcp:host=invalid']) test('missing or nonlocal accessibility address remains UNKNOWN: '+JSON.stringify(address),()=>{
  const {rows,calls}=check('no-known-atspi',{ATSPI_BUS_ADDRESS:address}); assert.equal(rows.tray_accessibility.status,'UNKNOWN');
  assert.ok(!calls.some(c=>c.args.some(a=>a.startsWith('--address='))));
});
test('macOS observed window is tray-bound but drawn visibility needs state-home identity',()=>{
  const {rows,calls}=check('mac-pass'); assert.equal(rows.menu_bar_item.status,'PASS'); assert.equal(rows.isolated_home.status,'UNKNOWN'); assert.equal(rows.drawn_visibility.status,'UNKNOWN');
  const probe=calls.find(c=>c.name==='python3'&&c.args[0]==='-c'); assert.equal(probe.args.at(-1),'702'); assert.match(probe.args[1],/CGWindowListCopyWindowInfo/);
});
for(const scenario of ['mac-denied','mac-malformed','mac-no-gui','mac-redacted','mac-nonnumeric','mac-empty','mac-ambiguous','mac-other-layer','mac-foreign-tray']) test('macOS unavailable/ambiguous '+scenario,()=>assert.equal(check(scenario).rows.menu_bar_item.status,'UNKNOWN'));
test('macOS transparent status window is FAIL',()=>assert.equal(check('mac-transparent').rows.menu_bar_item.status,'FAIL'));
test('SSH never enters the macOS GUI probe',()=>{
  const {rows,calls}=check('mac-ssh',{SSH_CONNECTION:'fixture'}); assert.equal(rows.menu_bar_item.status,'UNKNOWN'); assert.ok(!calls.some(c=>c.name==='python3'&&c.args[0]==='-c'));
});
test('embedded Python and native helper compile; no permission-request/capture calls',()=>{
  const source=readFileSync(script,'utf8');
  const payload=source.split("<<'PY'\n")[1].split('\nPY\n')[0];
  const result=spawnSync(python,['-c',String.raw`import ast,sys
tree=ast.parse(sys.stdin.read())
probe=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MAC_WINDOW_PROBE' for t in n.targets))
compile(probe,'mac-probe','exec')
assert not any(s in probe for s in ('CGRequestScreenCaptureAccess','CGWindowListCreateImage','AXIsProcessTrustedWithOptions','osascript'))
`],{input:payload,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
