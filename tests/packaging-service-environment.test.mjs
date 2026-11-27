import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFile as execFileCallback, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';

const execFile=promisify(execFileCallback);
const root=new URL('..',import.meta.url);
const repoPath=path=>new URL(path,root).pathname;

async function fixture(t) {
  const parent=join(homedir(),'.tmp');
  await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,'faravan-installer-qa-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const home=join(dir,'home'), config=join(home,'.config'), data=join(home,'.local','share'), apps=join(data,'applications'), bin=join(dir,'bin');
  await Promise.all([mkdir(config,{recursive:true}),mkdir(apps,{recursive:true}),mkdir(bin,{recursive:true})]);
  const log=join(dir,'opened.log');
  for(const [name,label] of [['brave-handler','Brave'],['chrome-handler','Chrome']]) {
    await writeFile(join(bin,name),`#!/bin/sh\nprintf '%s %s\\n' '${label}' "$1" >> '${log}'\n`,{mode:0o755});
  }
  await writeFile(join(apps,'brave.desktop'),'[Desktop Entry]\nType=Application\nName=Brave\nExec=brave-handler %u\n');
  await writeFile(join(apps,'google-chrome.desktop'),'[Desktop Entry]\nType=Application\nName=Chrome\nExec=chrome-handler %u\n');
  await writeFile(join(config,'kdeglobals'),'[General]\nBrowserApplication=brave.desktop\n');
  await writeFile(join(config,'mimeapps.list'),'[Default Applications]\nx-scheme-handler/https=google-chrome.desktop\n');
  await writeFile(join(bin,'kde-open5'),`#!/bin/sh\nif [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then exec chrome-handler "$1"; fi\nexec brave-handler "$1"\n`,{mode:0o755});
  const env={...process.env,HOME:home,XDG_CONFIG_HOME:config,XDG_DATA_HOME:data,XDG_DATA_DIRS:data,
    PATH:`${bin}:/usr/bin:/bin`,DISPLAY:':77',KDE_SESSION_VERSION:'5',XDG_UTILS_DEBUG_LEVEL:'2'};
  return {dir,home,config,data,apps,bin,log,env};
}

async function openWithXdg(env,url='https://example.invalid/faravan') {
  await execFile('/usr/bin/xdg-open',[url],{env,encoding:'utf8'});
}

test('headless xdg-open follows KDE default with session variables and shows the Chrome fallback without them',async t=>{
  const f=await fixture(t),url='https://example.invalid/faravan';
  await openWithXdg({...f.env,XDG_CURRENT_DESKTOP:'KDE',DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic/session-bus'},url);
  assert.equal((await readFile(f.log,'utf8')).trim(),`Brave ${url}`);
  await rm(f.log);
  const stripped={...f.env};
  delete stripped.XDG_CURRENT_DESKTOP;
  delete stripped.DBUS_SESSION_BUS_ADDRESS;
  await openWithXdg(stripped,url);
  assert.equal((await readFile(f.log,'utf8')).trim(),`Chrome ${url}`);
});

test('Linux units use a fixed system PATH without installer-specific entries',async()=>{
  const expected='Environment=PATH=/usr/lib/faravan/bin:/usr/lib/faravan/runtime/bin:/usr/local/bin:/usr/bin:/bin';
  for(const file of ['faravan-app.service','faravan-tray.service','faravan-coordinator.service']) {
    const unit=await readFile(repoPath(`packaging/assets/${file}`),'utf8');
    assert.ok(unit.split('\n').includes(expected),`${file} must set its own fixed PATH`);
    assert.doesNotMatch(expected,/mise|nvm|bun|cargo|cursor|%h\/\.local/);
  }
});

test('app and coordinator units stay off the desktop session bus while the tray may receive it',async()=>{
  for(const file of ['faravan-app.service','faravan-coordinator.service']) {
    const unit=await readFile(repoPath(`packaging/assets/${file}`),'utf8');
    assert.ok(unit.split('\n').includes('UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS'),`${file} must not inherit the desktop bus`);
  }
  const tray=await readFile(repoPath('packaging/assets/faravan-tray.service'),'utf8');
  assert.doesNotMatch(tray,/^UnsetEnvironment=.*DBUS_SESSION_BUS_ADDRESS/m,'the tray service keeps the imported desktop bus');
});

async function runTrayStarter(t,{source,sessionEnvironment,seed,removeKeys}){
  const f=await fixture(t);
  const systemctl=join(f.bin,'systemctl');
  const events=join(f.dir,'systemctl-events.json');
  const state=join(f.dir,'manager-environment.json');
  const shim=join(f.dir,'systemctl.mjs');
  await writeFile(shim,`import {readFile,writeFile} from 'node:fs/promises';\nconst args=process.argv.slice(2),action=args[1],names=args.slice(2);\nconst manager=JSON.parse(await readFile(process.env.TEST_SYSTEMD_ENV,'utf8').catch(()=> '{}'));\nconst record=async()=>writeFile(process.env.TEST_SYSTEMD_ENV,JSON.stringify(manager));\nlet exitCode=0;\nif(action==='unset-environment'){for(const name of names)delete manager[name];await record();}\nif(action==='import-environment'){for(const name of names)if(process.env[name]!==undefined)manager[name]=process.env[name];await record();}\nif(action==='is-active'){exitCode=(await readFile(process.env.TEST_TRAY_ACTIVE,'utf8').catch(()=> ''))==='active'?0:3;}\nif(action==='restart'){await writeFile(process.env.TEST_TRAY_PROCESS_ENV,JSON.stringify(manager));}\nif(action==='start'&&(await readFile(process.env.TEST_TRAY_ACTIVE,'utf8').catch(()=> ''))!=='active'){await writeFile(process.env.TEST_TRAY_ACTIVE,'active');await writeFile(process.env.TEST_TRAY_PROCESS_ENV,JSON.stringify(manager));}\nconst previous=JSON.parse(await readFile(process.env.TEST_SYSTEMD_EVENTS,'utf8').catch(()=> '[]'));previous.push(args);await writeFile(process.env.TEST_SYSTEMD_EVENTS,JSON.stringify(previous));\nif(exitCode)process.exit(exitCode);\n`);
  await writeFile(systemctl,`#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n`,{mode:0o755});
  const starter=join(f.dir,'faravan-tray-start');
  const lib=join(f.dir,'lib');
  await mkdir(lib);
  await writeFile(join(lib,'session-environment.sh'),sessionEnvironment);
  await writeFile(state,JSON.stringify(seed));
  await writeFile(join(f.dir,'tray-active'),'active');
  await writeFile(join(f.dir,'tray-process-environment.json'),JSON.stringify(seed));
  await writeFile(starter,source.replaceAll('/usr/bin/systemctl',systemctl).replace('/usr/lib/faravan/lib/session-environment.sh',join(lib,'session-environment.sh')),{mode:0o755});
  const session={...f.env,XDG_CURRENT_DESKTOP:'KDE',KDE_SESSION_VERSION:'6',DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic/session-bus',
    TEST_SYSTEMD_ENV:state,TEST_SYSTEMD_EVENTS:events,TEST_TRAY_ACTIVE:join(f.dir,'tray-active'),
    TEST_TRAY_PROCESS_ENV:join(f.dir,'tray-process-environment.json')};
  for(const key of removeKeys)delete session[key];
  const result=spawnSync('/bin/sh',[starter],{env:session,encoding:'utf8'});
  return {result,commands:JSON.parse(await readFile(events,'utf8')),manager:JSON.parse(await readFile(state,'utf8'))};
}

test('tray startup imports changed session values once and restarts only after a change',async t=>{
  const f=await fixture(t);
  const desktop=await readFile(repoPath('packaging/assets/faravan-tray.desktop'),'utf8');
  const startLine=desktop.split('\n').find(line=>line.startsWith('Exec='));
  assert.equal(startLine,'Exec=/usr/lib/faravan/bin/faravan-tray-start');
  const sourcePath=repoPath('packaging/assets/faravan-tray-start');
  const source=await readFile(sourcePath,'utf8');
  const sessionEnvironment=await readFile(repoPath('packaging/assets/faravan-session-environment.sh'),'utf8').catch(()=> '');
  assert.match(source,/session-environment\.sh/);
  assert.match(source,/for key in \$FARAVAN_SESSION_VARIABLES/);
  assert.match(sessionEnvironment,/DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP KDE_SESSION_VERSION XDG_RUNTIME_DIR XAUTHORITY XDG_SESSION_TYPE/);
  assert.match(source,/unset-environment/);
  assert.match(source,/import-environment/);
  const build=await readFile(repoPath('packaging/build.sh'),'utf8');
  assert.match(build,/install -D -m 0755 "\$package_dir\/assets\/faravan-tray-start" "\$stage_dir\/usr\/lib\/faravan\/bin\/faravan-tray-start"/);
  assert.match(build,/assets\/faravan-session-environment\.sh.*lib\/session-environment\.sh/);
  const systemctl=join(f.bin,'systemctl');
  const events=join(f.dir,'systemctl-events.json');
  const state=join(f.dir,'manager-environment.json');
  const shim=join(f.dir,'systemctl.mjs');
  await writeFile(shim,`import {readFile,writeFile} from 'node:fs/promises';\nconst args=process.argv.slice(2),action=args[1],names=args.slice(2);\nconst manager=JSON.parse(await readFile(process.env.TEST_SYSTEMD_ENV,'utf8').catch(()=> '{}'));\nconst record=async()=>writeFile(process.env.TEST_SYSTEMD_ENV,JSON.stringify(manager));\nlet exitCode=0;\nif(action==='unset-environment'){for(const name of names)delete manager[name];await record();}\nif(action==='import-environment'){for(const name of names)if(process.env[name]!==undefined)manager[name]=process.env[name];await record();}\nif(action==='is-active'){exitCode=(await readFile(process.env.TEST_TRAY_ACTIVE,'utf8').catch(()=> ''))==='active'?0:3;}\nif(action==='restart'){await writeFile(process.env.TEST_TRAY_PROCESS_ENV,JSON.stringify(manager));}\nif(action==='start'&&(await readFile(process.env.TEST_TRAY_ACTIVE,'utf8').catch(()=> ''))!=='active'){await writeFile(process.env.TEST_TRAY_ACTIVE,'active');await writeFile(process.env.TEST_TRAY_PROCESS_ENV,JSON.stringify(manager));}\nconst previous=JSON.parse(await readFile(process.env.TEST_SYSTEMD_EVENTS,'utf8').catch(()=> '[]'));previous.push(args);await writeFile(process.env.TEST_SYSTEMD_EVENTS,JSON.stringify(previous));\nif(exitCode)process.exit(exitCode);\n`);
  await writeFile(systemctl,`#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n`,{mode:0o755});
  const starter=join(f.dir,'faravan-tray-start');
  const lib=join(f.dir,'lib');
  await mkdir(lib);
  await writeFile(join(lib,'session-environment.sh'),sessionEnvironment);
  const seed={WAYLAND_DISPLAY:'wayland-old',XAUTHORITY:'/old/session/auth',KEEP_ME:'manager-value'};
  const shimSource=await readFile(shim,'utf8');
  await writeFile(shim,shimSource.replace("let exitCode=0;", "let exitCode=0;\nif(action==='show-environment')process.stdout.write(Object.entries(manager).map(([key,value])=>key+'='+value).join(String.fromCharCode(10))+String.fromCharCode(10));"));
  await writeFile(state,JSON.stringify(seed));
  await writeFile(join(f.dir,'tray-active'),'inactive');
  await writeFile(join(f.dir,'tray-process-environment.json'),JSON.stringify(seed));
  await writeFile(starter,source.replaceAll('/usr/bin/systemctl',systemctl).replace('/usr/lib/faravan/lib/session-environment.sh',join(lib,'session-environment.sh')),{mode:0o755});
  const session={...f.env,XDG_CURRENT_DESKTOP:'KDE',KDE_SESSION_VERSION:'6',DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic/session-bus',
    TEST_SYSTEMD_ENV:state,TEST_SYSTEMD_EVENTS:events,TEST_TRAY_ACTIVE:join(f.dir,'tray-active'),
    TEST_TRAY_PROCESS_ENV:join(f.dir,'tray-process-environment.json')};
  for(const key of ['WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XAUTHORITY','XDG_SESSION_TYPE'])delete session[key];
  const run=()=>spawnSync('/bin/sh',[starter],{env:session,encoding:'utf8'});
  const first=run();
  assert.equal(first.status,0,first.stderr);
  const second=run();
  assert.equal(second.status,0,second.stderr);
  let commands=JSON.parse(await readFile(events,'utf8'));
  assert.equal(commands.filter(args=>args[1]==='start').length,1);
  assert.equal(commands.filter(args=>args[1]==='restart').length,0);
  session.DISPLAY=':78';
  const third=run();
  assert.equal(third.status,0,third.stderr);
  commands=JSON.parse(await readFile(events,'utf8'));
  assert.equal(commands.filter(args=>args[1]==='start').length,1);
  assert.equal(commands.filter(args=>args[1]==='restart').length,1);
  assert.deepEqual(commands.filter(args=>args[1]==='import-environment').at(-1),['--user','import-environment','DISPLAY']);
  const manager=JSON.parse(await readFile(state,'utf8'));
  assert.equal(manager.XDG_CURRENT_DESKTOP,'KDE');
  assert.equal(manager.DBUS_SESSION_BUS_ADDRESS,'unix:path=/synthetic/session-bus');
  assert.equal(manager.KDE_SESSION_VERSION,'6');
  assert.equal(manager.WAYLAND_DISPLAY,undefined);
  assert.equal(manager.XAUTHORITY,undefined);
  assert.equal(manager.KEEP_ME,'manager-value');
  const processEnvironment=JSON.parse(await readFile(join(f.dir,'tray-process-environment.json'),'utf8'));
  assert.equal(processEnvironment.DISPLAY,':78');
  assert.equal(processEnvironment.WAYLAND_DISPLAY,undefined);
  assert.equal(processEnvironment.XAUTHORITY,undefined);
  await openWithXdg({...f.env,...manager,KDE_SESSION_VERSION:'5'});
  assert.match(await readFile(f.log,'utf8'),/^Brave /);
});

test('the packaged CLI starts the tray through its session-importing starter',async()=>{
  const cli=await readFile(repoPath('bin/faravan'),'utf8');
  assert.match(cli,/packagedLinux\?path\.join\(ROOT,'bin','faravan-tray-start'\)/);
});

test('a caller with no desktop session leaves the user manager environment and a running tray alone',async t=>{
  const source=await readFile(repoPath('packaging/assets/faravan-tray-start'),'utf8');
  const sessionEnvironment=await readFile(repoPath('packaging/assets/faravan-session-environment.sh'),'utf8');
  const seed={DISPLAY:':0',WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',XDG_CURRENT_DESKTOP:'KDE'};
  const {result,commands,manager}=await runTrayStarter(t,{source,sessionEnvironment,seed,
    removeKeys:['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_CURRENT_DESKTOP','KDE_SESSION_VERSION','XAUTHORITY','XDG_SESSION_TYPE']});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(commands,[['--user','start','faravan-tray.service']]);
  assert.deepEqual(manager,seed);
});
