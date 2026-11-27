import './helpers/no-browser.mjs';
import { createHash } from 'node:crypto';
import {credentialStoreEnv} from '../lib/docker-backend.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import { systemdShowEnvironment } from './helpers/systemd-environment.mjs';

const execFile = promisify(execFileCallback);
const hook = fileURLToPath(new URL('../packaging/scripts/remove.sh', import.meta.url));
const postinstall = fileURLToPath(new URL('../packaging/scripts/postinstall.sh', import.meta.url));
const nfpmPath = fileURLToPath(new URL('../packaging/nfpm.yaml', import.meta.url));
const buildPath = fileURLToPath(new URL('../packaging/build.sh', import.meta.url));

async function setup(t, {sessions = '', sessionClasses = {}, managerUsers = '', stillActiveUser = '', appRunning = 'false', appInfoStatus = '0', quitStatus = '0', busyUser = '', failDataRemoveUser = '', signalDuringDataRemoveUser = '', purgeStatus = 'ri ', purgePrepareStatus = '0', noBusUser = '', hostStopStatus = '0', appNeverExits = 'no', sbxUnits = '', ownedSbxUnits = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', showFailUnit = '__none__', disableFailUser = '__none__', stopFailUnit = '__none__', deactivatingUnit = '__none__'} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-package-remove-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const bin = join(root, 'bin'), runLog = join(root, 'runuser.log'), systemctlLog = join(root, 'systemctl.log'), orderLog = join(root, 'order.log');
  const infoDir = join(root, 'dpkg-info'), removalStateDir = join(root, 'removal-state');
  const sessionListFile = join(root, 'sessions.list'), sessionMetaFile = join(root, 'sessions.meta'), userListFile = join(root, 'users.list');
  const sessionRows = sessions.split(/\r?\n/).filter(Boolean).map(line => {
    const [id, uid, user, seat = '-', tty = '-', state = 'active'] = line.trim().split(/\s+/);
    const className = sessionClasses[id] ?? 'user';
    const active = state === 'active' ? 'yes' : 'no';
    return {id, uid, user, seat, tty, className, active};
  });
  await writeFile(sessionListFile, sessionRows.map(session =>
    `${session.id} ${session.uid} ${session.user} ${session.seat} 4242 ${session.className} ${session.tty} no 3 days ago`).join('\n'));
  await writeFile(sessionMetaFile, sessionRows.map(session =>
    `${session.id} ${session.className} ${session.active}`).join('\n'));
  // `loginctl list-users` rows as printed on a real host: UID USER LINGER STATE.
  await writeFile(userListFile, managerUsers.split(/\r?\n/).filter(Boolean).map(line =>
    `${line.trim().split(/\s+/)[0]} ${line.trim().split(/\s+/)[1]} yes active`).join('\n'));
  await mkdir(bin);
  await mkdir(infoDir);
  await copyFile(hook, join(infoDir, 'prerm'));
  await copyFile(hook, join(infoDir, 'postrm'));
  await copyFile(postinstall, join(infoDir, 'postinst'));
  const shim = async (name, body) => {
    const path = join(bin, name);
    await writeFile(path, '#!/bin/sh\n' + body + '\n');
    await chmod(path, 0o755);
  };
  await shim('loginctl', [
    'case "$1" in',
    '  list-sessions) cat "$TEST_SESSION_LIST" ;;',
    '  list-users) cat "$TEST_USER_LIST" ;;',
    '  show-session) session=$2; awk -v id="$session" \'$1 == id { print "Class=" $2; print "Active=" $3; found=1 } END { if (!found) exit 1 }\' "$TEST_SESSION_META" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'));
  await shim('getent', [
    'case "$2" in',
    '  alice) printf "alice:x:1001:1001::%s/alice:/bin/sh\\n" "$TEST_HOME" ;;',
    '  bob) printf "bob:x:1002:1002::%s/bob:/bin/sh\\n" "$TEST_HOME" ;;',
    '  carol) printf "carol:x:1003:1003::%s/carol:/bin/sh\\n" "$TEST_HOME" ;;',
    '  *) [ "$1" = passwd ] || exit 2; printf "alice:x:1001:1001::%s/alice:/bin/sh\\nbob:x:1002:1002::%s/bob:/bin/sh\\ncarol:x:1003:1003::%s/carol:/bin/sh\\n" "$TEST_HOME" "$TEST_HOME" "$TEST_HOME" ;;',
    'esac',
  ].join('\n'));
  await shim('runuser', [
    'user=$2; shift 2; [ "$1" = -- ] || exit 2; shift',
    '[ "$1" = env ] && shift',
    'while [ "$1" = -u ]; do unset "$2"; shift 2; done',
    'while [ $# -gt 0 ]; do case "$1" in *=*) export "$1"; shift ;; *) break ;; esac; done',
    'command=$1; shift',
    'printf "%s %s\\n" "$user" "$command $*" >> "$TEST_RUNUSER_LOG"',
    'printf "runuser %s %s %s\\n" "$user" "$command" "$*" >> "$TEST_ORDER_LOG"',
    'case "$command $*" in',
    '  "/usr/lib/faravan/runtime/bin/node /usr/lib/faravan/lib/sbx-daemon-owner.mjs --id"*) exec "$TEST_NODE" "$TEST_OWNER_HELPER" --id "${3:-}" /usr/lib/faravan ;;',
    '  "/usr/lib/faravan/runtime/bin/node /usr/lib/faravan/lib/sbx-daemon-unit-check.mjs "*) exec "$TEST_NODE" "$TEST_UNIT_HELPER" "$2" "${3:-}" /usr/lib/faravan ;;',
    '  "/usr/bin/faravan app info --json")',
    '    [ "$TEST_APP_INFO_STATUS" = 0 ] || exit "$TEST_APP_INFO_STATUS"',
    '    running=$(cat "$TEST_APP_STATE.$user" 2>/dev/null || printf "%s" "$TEST_APP_RUNNING")',
    '    printf "{\\"running\\":%s,\\"home\\":\\"%s/%s/.local/share/Faravan\\"}\\n" "$running" "$TEST_HOME" "$user" ;;',
    '  "/usr/bin/faravan app quit --yes --json")',
    '    [ "$user" = "$TEST_BUSY_USER" ] && exit 4',
    '    [ "$TEST_QUIT_STATUS" = 0 ] && [ "$TEST_APP_NEVER_EXITS" = no ] && printf false > "$TEST_APP_STATE.$user"',
    '    exit "$TEST_QUIT_STATUS" ;;',
    '  "/usr/bin/faravan uninstall --yes --delete-hosted-circles --package-prepare-only --json") exit "$TEST_PURGE_PREP_STATUS" ;;',
    '  "/usr/bin/faravan host --stop --json") [ "${FARAVAN_PACKAGE_REMOVAL_FALLBACK:-}" = 1 ] || exit 8; exit "$TEST_HOST_STOP_STATUS" ;;',
    '  *)',
    '    if [ "$command" = rm ] && [ "$user" = "$TEST_SYMLINK_AUTOSTART_USER" ] && [ -L "$TEST_HOME/$user/.config/autostart" ]; then exit 13; fi',
    '    if [ "$command" = rm ] && [ "$user" = "$TEST_SIGNAL_DATA_REMOVE_USER" ] && [ "$1" = -rf ]; then kill -TERM "$PPID"; exit 0; fi',
    '    if [ "$command" = rm ] && [ "$user" = "$TEST_FAIL_DATA_REMOVE_USER" ] && [ "$1" = -rf ]; then exit 14; fi',
    '    case "$command" in rm|find) exec "$command" "$@" ;; *) exit 2 ;; esac ;;',
    'esac',
  ].join('\n'));
  await shim('systemctl', [
    'printf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG"',
    'printf "systemctl %s\\n" "$*" >> "$TEST_ORDER_LOG"',
    'case " $* " in',
    '  *"-M $TEST_NO_BUS_USER@ "*) exit 1 ;;',
    'esac',
    // Sandbox services: TEST_SBX_UNITS lists them; a name with aaaaaaaaaaaa belongs to the stable channel, any other to another.
    'case " $* " in',
    '  *" list-units "*) printf "%s\\n" "$TEST_SBX_UNITS"; exit 0 ;;',
    '  *" show -p Description --value "*) case " $* " in *"$TEST_SHOW_FAIL_UNIT"*) exit 7 ;; esac; case " $TEST_OWNED_SBX_UNITS " in *" $8 "*) echo "Faravan sandbox service (faravan)" ;; *) echo "Faravan sandbox service (preview-other)" ;; esac; exit 0 ;;',
    '  *" show -p LoadState "*) user=${3%@}; cat "$TEST_UNIT_EVIDENCE.$user"; exit 0 ;;',
    '  *" show -p Environment --value "*) printf "FARAVAN_SBXD_OWNER_ID=%s\\n" "$TEST_SBX_OWNER"; exit 0 ;;',
    '  *" disable --now "*) [ "$1" = --user ] || exit 2; case " $* " in *" -M $TEST_DISABLE_FAIL_USER@ "*) exit 8 ;; esac; exit 0 ;;',
    '  *" stop "*) case " $* " in *" $TEST_STOP_FAIL_UNIT "*) exit 9 ;; esac; exit 0 ;;',
    'esac',
    // A unit reads as active (0) only for the user named by TEST_STILL_ACTIVE_USER; every other unit is inactive (3).
    'case " $* " in',
    '  *" is-active "*) case " $* " in *" $TEST_DEACTIVATING_UNIT "*) echo deactivating; exit 3 ;; *" -M $TEST_STILL_ACTIVE_USER@ "*) echo active; exit 0 ;; esac; echo inactive; exit 3 ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  await shim('dpkg-query', 'printf "%s\\n" "$TEST_DPKG_STATUS"');
  const userHome = join(root, 'users');
  for (const name of ['alice','bob']) {
    const user = join(userHome, name);
    const data = join(userHome, name, '.local/share/Faravan');
    await mkdir(join(data, 'keys'), {recursive:true});
    const env={...credentialStoreEnv(join(user,'.wfsbx'),'linux'),FARAVAN_SBXD_OWNER_ID:'a'.repeat(64),FARAVAN_SBXD_INSTALL_ROOT:'/usr/lib/faravan',FARAVAN_SBXD_DATA_HOME:data};
    await writeFile(join(root,'unit-evidence.'+name),[
      'LoadState=loaded','ActiveState=active','MainPID=4242','Description=Faravan sandbox service (faravan)',
      'ExecStart={ path=/usr/bin/sbx ; argv[]=/usr/bin/sbx daemon start ; }',
      'Environment='+systemdShowEnvironment(env),
    ].join('\n'));
    const ownerKey = createHash('sha256').update('/usr/lib/faravan').digest('hex');
    await writeFile(join(data,'sbx-daemon-owner-'+ownerKey+'.json'), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
    await mkdir(join(data, 'ledger'), {recursive:true});
    await mkdir(join(data, 'coordinator'), {recursive:true});
    await mkdir(join(user, '.config/autostart'), {recursive:true});
    await mkdir(join(user, '.config/systemd/user/default.target.wants'), {recursive:true});
    await mkdir(join(user, '.config/systemd/user/graphical-session.target.wants'), {recursive:true});
    await writeFile(join(user, '.config/autostart/faravan-tray.desktop'), 'tray activation sentinel\n');
    await symlink('/usr/lib/systemd/user/faravan-app.service', join(user, '.config/systemd/user/default.target.wants/faravan-app.service'));
    await symlink('/usr/lib/systemd/user/faravan-coordinator.service', join(user, '.config/systemd/user/default.target.wants/faravan-coordinator.service'));
    await symlink('/usr/lib/systemd/user/faravan-app.service', join(user, '.config/systemd/user/graphical-session.target.wants/faravan-app.service'));
    await writeFile(join(data, 'keys/member.key'), `${name} member key sentinel\n`);
    await writeFile(join(data, 'ledger/ledger.sqlite'), `${name} ledger sentinel\n`);
    await writeFile(join(data, 'coordinator/daemon.json'), `${name} daemon sentinel\n`);
  }
  const env = {...process.env, PATH:bin + ':' + process.env.PATH, DPKG_MAINTSCRIPT_NAME:'prerm',
    DPKG_MAINTSCRIPT_PACKAGE:'faravan-test', FARAVAN_REMOVAL_TEST_STATE_DIR:removalStateDir,
    TEST_UNIT_EVIDENCE:join(root,'unit-evidence'), TEST_UNIT_HELPER:fileURLToPath(new URL('../lib/sbx-daemon-unit-check.mjs',import.meta.url)), TEST_NODE:process.execPath, TEST_OWNER_HELPER:fileURLToPath(new URL('../lib/sbx-daemon-owner.mjs',import.meta.url)), TEST_HOME:userHome, TEST_SESSION_LIST:sessionListFile, TEST_SESSION_META:sessionMetaFile, TEST_APP_RUNNING:appRunning,
    TEST_APP_INFO_STATUS:appInfoStatus, TEST_QUIT_STATUS:quitStatus, TEST_BUSY_USER:busyUser,
    TEST_FAIL_DATA_REMOVE_USER:failDataRemoveUser,
    TEST_SIGNAL_DATA_REMOVE_USER:signalDuringDataRemoveUser,
    TEST_APP_STATE:join(root, 'app-state'), TEST_APP_NEVER_EXITS:appNeverExits,
    TEST_DPKG_STATUS:purgeStatus, TEST_PURGE_PREP_STATUS:purgePrepareStatus, TEST_HOST_STOP_STATUS:hostStopStatus,
    TEST_NO_BUS_USER:noBusUser, TEST_STILL_ACTIVE_USER:stillActiveUser, TEST_SBX_UNITS:sbxUnits, TEST_USER_LIST:userListFile,
    TEST_SHOW_FAIL_UNIT:showFailUnit, TEST_DISABLE_FAIL_USER:disableFailUser, TEST_STOP_FAIL_UNIT:stopFailUnit, TEST_DEACTIVATING_UNIT:deactivatingUnit,
    TEST_OWNED_SBX_UNITS:ownedSbxUnits, TEST_SBX_OWNER:'a'.repeat(64),
    TEST_SYMLINK_AUTOSTART_USER:'', TEST_RUNUSER_LOG:runLog, TEST_SYSTEMCTL_LOG:systemctlLog, TEST_ORDER_LOG:orderLog};
  const invoke = (phase, action) => execFile('sh', [join(infoDir, phase), action], {env:{...env, DPKG_MAINTSCRIPT_NAME:phase}, maxBuffer:1024 * 1024})
    .then(result => ({code:0, stdout:result.stdout, stderr:result.stderr}), error => ({code:error.code ?? 1, stdout:error.stdout ?? '', stderr:error.stderr ?? ''}));
  const invokePostinst = action => execFile('sh', [join(infoDir, 'postinst'), action],
    {env:{...env, DPKG_MAINTSCRIPT_NAME:'postinst'}, maxBuffer:1024 * 1024})
    .then(result => ({code:0, stdout:result.stdout, stderr:result.stderr}), error => ({code:error.code ?? 1, stdout:error.stdout ?? '', stderr:error.stderr ?? ''}));
  return {root, userHome, infoDir, removalStateDir, env, runLog, systemctlLog, orderLog, invoke, invokePostinst};
}

async function assertUserDataKept(userHome, names = ['alice','bob']) {
  for (const name of names) {
    const data = join(userHome, name, '.local/share/Faravan');
    assert.equal(await readFile(join(data, 'keys/member.key'), 'utf8'), `${name} member key sentinel\n`);
    assert.equal(await readFile(join(data, 'ledger/ledger.sqlite'), 'utf8'), `${name} ledger sentinel\n`);
    assert.equal(await readFile(join(data, 'coordinator/daemon.json'), 'utf8'), `${name} daemon sentinel\n`);
  }
}

test('nFPM and dpkg-deb packages declare both removal hooks', async () => {
  const nfpm = await readFile(nfpmPath, 'utf8');
  const build = await readFile(buildPath, 'utf8');
  const remove = await readFile(hook, 'utf8');
  assert.match(nfpm, /^  preremove: \.\/scripts\/remove\.sh$/m);
  assert.match(nfpm, /^  postremove: \.\/scripts\/remove\.sh$/m);
  assert.match(build, /remove\.sh" "\$root\/DEBIAN\/prerm"/);
  assert.match(build, /remove\.sh" "\$root\/DEBIAN\/postrm"/);
  assert.match(remove, /purge_state_dir=\/var\/lib\/faravan-removal/);
  assert.match(remove, /DPKG_MAINTSCRIPT_PACKAGE:-faravan/);
});

test('production maintainer scripts ignore the test-state override for other package names', async t => {
  const f = await setup(t);
  const auditBin = join(f.root, 'path-audit-bin'), auditLog = join(f.root, 'path-audit.log');
  await mkdir(auditBin);
  for (const command of ['rm','rmdir']) {
    const path = join(auditBin, command);
    await writeFile(path, `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$TEST_PATH_AUDIT_LOG"\n`);
    await chmod(path, 0o755);
  }
  const env = {...f.env, PATH:auditBin + ':' + f.env.PATH, DPKG_MAINTSCRIPT_PACKAGE:'another-package',
    FARAVAN_REMOVAL_TEST_STATE_DIR:join(f.root, 'must-not-be-used'), TEST_PATH_AUDIT_LOG:auditLog};

  await execFile('sh', [join(f.infoDir, 'prerm'), 'remove'],
    {env:{...env, DPKG_MAINTSCRIPT_NAME:'prerm'}, maxBuffer:1024 * 1024});
  await execFile('sh', [join(f.infoDir, 'postinst'), 'abort-remove'],
    {env:{...env, DPKG_MAINTSCRIPT_NAME:'postinst'}, maxBuffer:1024 * 1024});
  const paths = await readFile(auditLog, 'utf8');
  assert.equal((paths.match(/\/var\/lib\/faravan-removal\/purge-prepared/g) ?? []).length, 2);
  assert.doesNotMatch(paths, /must-not-be-used/);
});

test('upgrade maintainer-script arguments do not stop users or change the package lifecycle', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active'});
  for (const phase of ['prerm','postrm']) {
    const result = await f.invoke(phase, 'upgrade');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(await readFile(f.runLog, 'utf8').catch(() => ''), '');
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('session discovery uses loginctl Active and Class properties, including manager sessions', async t => {
  const f = await setup(t, {
    sessions:'7 1001 alice - - active\n8 1002 bob seat0 tty3 active',
    sessionClasses:{7:'manager', 8:'greeter'},
  });
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const commands = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(commands, ['alice /usr/bin/faravan app info --json']);
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user -M alice@ disable --now/);
  assert.doesNotMatch(await readFile(f.systemctlLog, 'utf8'), /bob@/);
});

test('removal stops only this installation\'s sandbox services and reads each stop back', async t => {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', other = 'faravan-sbxd-bbbbbbbbbbbb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
  const f = await setup(t, {sessions:'4 1001 alice - - active', sbxUnits:`${mine} loaded active running x\n${other} loaded active running x`});
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = await readFile(f.systemctlLog, 'utf8');
  assert.match(calls, new RegExp(`--user -M alice@ stop ${mine}`));
  assert.match(calls, new RegExp(`--user -M alice@ is-active ${mine}`), 'the stop is read back');
  assert.doesNotMatch(calls, new RegExp(`stop ${other}`), 'another channel\'s service is left alone');
});

test('an unreadable sandbox unit description cancels removal', async t => {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
  const f = await setup(t, {sessions:'4 1001 alice - - active', sbxUnits:`${mine} loaded active running x`, showFailUnit:mine});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not be proven stopped/);
  await assertUserDataKept(f.userHome, ['alice']);
});

test('owned sandbox units are stopped and read back even when app-unit disable fails', async t => {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', alsoMine = 'faravan-sbxd-bbbbbbbbbbbb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
  const f = await setup(t, {
    sessions:'4 1001 alice - - active',
    sbxUnits:`${mine} loaded active running x\n${alsoMine} loaded active running x`,
    ownedSbxUnits:`${mine} ${alsoMine}`,
    disableFailUser:'alice',
  });
  const result = await f.invoke('prerm', 'remove');
  const calls = await readFile(f.systemctlLog, 'utf8');
  assert.match(calls, new RegExp(`--user -M alice@ stop ${mine}`));
  assert.match(calls, new RegExp(`--user -M alice@ is-active ${mine}`));
  assert.match(calls, new RegExp(`--user -M alice@ stop ${alsoMine}`));
  assert.match(calls, new RegExp(`--user -M alice@ is-active ${alsoMine}`));
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('a deactivating sandbox unit still blocks package removal', async t => {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
  const f = await setup(t, {sessions:'4 1001 alice - - active', sbxUnits:`${mine} loaded active running x`, stopFailUnit:mine, deactivatingUnit:mine});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not be proven stopped/);
  assert.match(await readFile(f.systemctlLog, 'utf8'), new RegExp(`--user -M alice@ is-active ${mine}`));
  await assertUserDataKept(f.userHome, ['alice']);
});

test('removal asks every active app to quit before stopping services and keeps user data', async t => {
  const f = await setup(t, {sessions:'3 1002 bob seat0 tty2 active\n4 1001 alice - - active\n5 1002 bob - - closing', appRunning:'true'});
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /not a data purge/);
  const commands = await readFile(f.runLog, 'utf8');
  const appCommands = commands.trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(appCommands, [
    'alice /usr/bin/faravan app info --json',
    'alice /usr/bin/faravan app quit --yes --json',
    'alice /usr/bin/faravan app info --json',
    'bob /usr/bin/faravan app info --json',
    'bob /usr/bin/faravan app quit --yes --json',
    'bob /usr/bin/faravan app info --json',
  ]);
  const systemctl = await readFile(f.systemctlLog, 'utf8');
  assert.match(systemctl, /--user -M alice@ disable --now faravan-app\.service faravan-coordinator\.service/);
  assert.match(systemctl, /--user -M bob@ disable --now faravan-app\.service faravan-coordinator\.service/);
  for (const name of ['alice','bob']) {
    const user = join(f.userHome, name);
    for (const file of ['.config/autostart/faravan-tray.desktop',
      '.config/systemd/user/default.target.wants/faravan-app.service',
      '.config/systemd/user/default.target.wants/faravan-coordinator.service',
      '.config/systemd/user/graphical-session.target.wants/faravan-app.service'])
      await assert.rejects(lstat(join(user, file)), {code:'ENOENT'}, file + ' activation is removed');
  }
  assert.match(commands, /alice rm -f -- .*alice\/\.config\/autostart\/faravan-tray\.desktop/);
  assert.match(commands, /alice find .*alice\/\.config\/systemd\/user/);
  await assertUserDataKept(f.userHome);
});

test('activation cleanup uses user permissions across a symlinked autostart directory', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active'});
  const alice = join(f.userHome, 'alice');
  const outside = join(f.root, 'outside-autostart');
  await rm(join(alice, '.config/autostart'), {recursive:true, force:true});
  await mkdir(outside);
  await writeFile(join(outside, 'faravan-tray.desktop'), 'outside sentinel\n');
  await symlink(outside, join(alice, '.config/autostart'));
  f.env.TEST_SYMLINK_AUTOSTART_USER = 'alice';

  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not remove alice's tray autostart entry/);
  assert.equal(await readFile(join(outside, 'faravan-tray.desktop'), 'utf8'), 'outside sentinel\n');
});

test('a running lent job blocks removal through the app quit API without an off command', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', appRunning:'true', quitStatus:'4'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /active work had finished/);
  assert.match(result.stderr, /nothing was force-stopped/);
  const commands = await readFile(f.runLog, 'utf8');
  assert.doesNotMatch(commands, /lending off --json/);
  assert.match(commands, /app quit --yes --json/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('removal waits for the normal app shutdown and cancels if the app remains running', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', appRunning:'true', appNeverExits:'yes'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /did not finish its normal shutdown/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('an app-state check failure cancels removal before services are touched', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', appInfoStatus:'1'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not check alice's app over its local API/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a later busy user aborts purge before circle lifecycle, service stops or data deletion', async t => {
  const f = await setup(t, {
    sessions:'1 1001 alice seat0 tty2 active\n2 1002 bob seat0 tty3 active',
    appRunning:'true', busyUser:'bob', purgeStatus:'pi ',
  });
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /bob's app could not confirm that active work had finished/);
  assert.match(result.stderr, /these apps accepted clean shutdown: alice\. Run 'faravan' to start them again/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  assert.equal(await readFile(f.env.TEST_APP_STATE + '.alice', 'utf8'), 'false',
    'the earlier app is cleanly stopped, and the cancellation message says how to reopen it');
  assert.doesNotMatch(await readFile(f.runLog, 'utf8'), /uninstall --yes --delete-hosted-circles/);
  await assertUserDataKept(f.userHome);
});

test('a missing user bus cannot prove sandbox units stopped, so package removal is canceled', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', noBusUser:'alice'});
  const before = await f.invoke('prerm', 'remove');
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /could not be proven stopped/);
  const calls = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(calls, ['alice /usr/bin/faravan app info --json']);
  assert.match(await readFile(f.systemctlLog, 'utf8'), /list-units/);
  await assertUserDataKept(f.userHome, ['alice']);
});

test('no active sessions and no user bus are handled without deleting user data', async t => {
  const f = await setup(t);
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No active user sessions/);
  assert.match(result.stdout, /not a data purge/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome);
});

test('an explicit purge with no active user API is canceled and keeps the device data', async t => {
  const f = await setup(t, {purgeStatus:'pi '});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /log in to an active user session, then retry apt purge/);
  assert.match(result.stdout, /FARAVAN_HOME data was kept/);
  await assertUserDataKept(f.userHome);
});

test('postrm without an active session reports reinstall recovery after package files are gone', async t => {
  const f = await setup(t, {purgeStatus:'pi '});
  const result = await f.invoke('postrm', 'purge');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Reinstall Faravan, log in, complete the owner lifecycle, then purge again/);
  assert.doesNotMatch(result.stderr, /run `(?:faravan|faravan) uninstall/);
  await assertUserDataKept(f.userHome);
});

test('an explicit purge prepares owner lifecycle before deleting data; a normal remove preserves it', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active\n2 1002 bob seat0 tty3 active', appRunning:'true', purgeStatus:'pi '});
  const before = await f.invoke('prerm', 'remove');
  assert.equal(before.code, 0, before.stdout + before.stderr);
  assert.match(before.stdout, /purge requested/i);
  const calls = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(calls, [
    'alice /usr/bin/faravan app info --json',
    'alice /usr/bin/faravan app quit --yes --json',
    'alice /usr/bin/faravan app info --json',
    'bob /usr/bin/faravan app info --json',
    'bob /usr/bin/faravan app quit --yes --json',
    'bob /usr/bin/faravan app info --json',
    'alice /usr/bin/faravan uninstall --yes --delete-hosted-circles --package-prepare-only --json',
    'bob /usr/bin/faravan uninstall --yes --delete-hosted-circles --package-prepare-only --json',
  ]);
  const ordered = (await readFile(f.orderLog, 'utf8')).trim().split('\n');
  const lastLifecycle = ordered.findLastIndex(line => line.includes('/usr/bin/faravan uninstall --yes --delete-hosted-circles'));
  const firstServiceStop = ordered.findIndex(line => line.startsWith('systemctl --user -M alice@ disable --now'));
  assert.ok(lastLifecycle >= 0 && firstServiceStop > lastLifecycle,
    'owner lifecycle runs while the coordinator unit is still available');
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user -M alice@ disable --now faravan-app\.service faravan-coordinator\.service/);
  assert.match(await readFile(f.runLog, 'utf8'), /alice rm -rf -- .*alice\/\.local\/share\/Faravan/);
  assert.equal(await readFile(join(f.userHome, 'alice/.local/share/Faravan/keys/member.key'), 'utf8').catch(() => null), null);
  assert.match(before.stdout, /Purged alice's FARAVAN_HOME data/);
  assert.equal(await readFile(join(f.userHome, 'bob/.local/share/Faravan/keys/member.key'), 'utf8').catch(() => null), null);
  assert.equal(await readFile(join(f.removalStateDir, 'purge-prepared'), 'utf8'), 'prepared\n');

  const after = await f.invoke('postrm', 'purge');
  assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.doesNotMatch(after.stdout, /not a data purge/);
  await assert.rejects(readFile(join(f.removalStateDir, 'purge-prepared')));
  await assertUserDataKept(f.userHome, []);
});

test('purge after a previous remove refuses to claim data was purged without its lifecycle helper', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active'});
  const removed = await f.invoke('prerm', 'remove');
  assert.equal(removed.code, 0, removed.stdout + removed.stderr);
  await assertUserDataKept(f.userHome, ['alice']);

  const purged = await f.invoke('postrm', 'purge');
  assert.equal(purged.code, 0, purged.stdout + purged.stderr);
  assert.match(purged.stderr, /purge preparation did not run before package files were removed.*FARAVAN_HOME data was kept/);
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a normal remove clears a stale purge marker before preserving user data', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active'});
  await mkdir(f.removalStateDir, {recursive:true});
  await writeFile(join(f.removalStateDir, 'purge-prepared'), 'stale marker\n');

  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(join(f.removalStateDir, 'purge-prepared')));
  await assertUserDataKept(f.userHome, ['alice']);
});

test('postinst abort-remove clears the marker when dpkg aborts a package removal', async t => {
  const f = await setup(t);
  await mkdir(f.removalStateDir, {recursive:true});
  await writeFile(join(f.removalStateDir, 'purge-prepared'), 'prepared\n');

  const result = await f.invokePostinst('abort-remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(join(f.removalStateDir, 'purge-prepared')));
  await assert.rejects(lstat(f.removalStateDir));
});

test('purge cancels after the lifecycle error without deleting data', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', purgeStatus:'pi ', purgePrepareStatus:'9'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /circle lifecycle could not be completed/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '',
    'a failed circle lifecycle leaves all user services available');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('failed data cleanup leaves no purge marker and keeps paths that were not removed', async t => {
  const f = await setup(t, {
    sessions:'1 1001 alice seat0 tty2 active', purgeStatus:'pi ', failDataRemoveUser:'alice',
  });
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /FARAVAN_HOME data could not be purged/);
  await assert.rejects(readFile(join(f.removalStateDir, 'purge-prepared')));
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a termination signal after the purge marker is written clears the marker and keeps data', async t => {
  const f = await setup(t, {
    sessions:'1 1001 alice seat0 tty2 active', purgeStatus:'pi ', signalDuringDataRemoveUser:'alice',
  });
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  await assert.rejects(readFile(join(f.removalStateDir, 'purge-prepared')));
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a missing user bus stops removal before the host fallback can hide an unknown sandbox unit', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', appRunning:'true', noBusUser:'alice', hostStopStatus:'7'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not be proven stopped/);
  const calls = (await readFile(f.runLog, 'utf8')).trim().split('\n');
  assert.deepEqual(calls.slice(0, 3), [
    'alice /usr/bin/faravan app info --json',
    'alice /usr/bin/faravan app quit --yes --json',
    'alice /usr/bin/faravan app info --json',
  ]);
  assert.equal((await lstat(join(f.userHome, 'alice/.config/autostart/faravan-tray.desktop'))).isFile(), true,
    'activation remains because package removal was canceled');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('the report case: inactive sessions are checked and drained before any service is stopped', async t => {
  // Two people whose sessions are off the foreground seat. Their apps may still be running jobs.
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 online\n2 1002 bob seat0 tty3 online'});
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const apps = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(apps, ['alice /usr/bin/faravan app info --json', 'bob /usr/bin/faravan app info --json']);
  const order = (await readFile(f.orderLog, 'utf8')).trim().split('\n');
  assert.ok(order.findIndex(line => line.startsWith('systemctl ')) > order.findIndex(line => line.includes('faravan app info')),
    'every app is checked before the first service stop');
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user -M bob@ disable --now/);
  await assertUserDataKept(f.userHome);
});

test('a switched-away session whose app is busy blocks removal before any service stop', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 online', appRunning:'true', quitStatus:'4'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /alice's app could not confirm that active work had finished/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a lingering user with no session is drained before its services stop', async t => {
  const f = await setup(t, {managerUsers:'1003 carol', appRunning:'true'});
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const apps = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.deepEqual(apps, [
    'carol /usr/bin/faravan app info --json',
    'carol /usr/bin/faravan app quit --yes --json',
    'carol /usr/bin/faravan app info --json',
  ]);
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user -M carol@ disable --now/);
});

test('a service still active after its stop cancels removal before the activation links are removed', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active', stillActiveUser:'alice'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /alice's Faravan services could not be proven stopped/);
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user -M alice@ is-active faravan-app\.service/);
  assert.equal((await lstat(join(f.userHome, 'alice/.config/autostart/faravan-tray.desktop'))).isFile(), true,
    'activation remains because removal was canceled');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('purge deletes data only for users with an active session, and a drained inactive user keeps its data', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active\n2 1002 bob seat0 tty3 online', purgeStatus:'pi '});
  const result = await f.invoke('prerm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const apps = (await readFile(f.runLog, 'utf8')).trim().split('\n').filter(line => line.includes('/usr/bin/faravan'));
  assert.ok(apps.includes('bob /usr/bin/faravan app info --json'), 'bob is checked for a running app');
  await assert.rejects(lstat(join(f.userHome, 'alice/.local/share/Faravan/keys/member.key')), {code:'ENOENT'});
  await assertUserDataKept(f.userHome, ['bob']);
  assert.match(result.stdout, /bob has no active session, so purge does not delete it/);
});

test('an explicit purge with only inactive sessions is canceled before any app is asked to quit', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 online', appRunning:'true', purgeStatus:'pi '});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /log in to an active user session, then retry apt purge/);
  assert.equal(await readFile(f.env.TEST_APP_STATE + '.alice', 'utf8').catch(() => 'not asked'), 'not asked');
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome);
});

test('a switched-away session whose app state cannot be read cancels removal before any service is stopped', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 online', appInfoStatus:'1'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not check alice's app over its local API/);
  assert.equal(await readFile(f.systemctlLog, 'utf8').catch(() => ''), '');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('a switched-away session whose service is still active after its stop cancels removal', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 online', stillActiveUser:'alice'});
  const result = await f.invoke('prerm', 'remove');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /alice's Faravan services could not be proven stopped/);
  assert.equal((await lstat(join(f.userHome, 'alice/.config/autostart/faravan-tray.desktop'))).isFile(), true,
    'activation remains because removal was canceled');
  await assertUserDataKept(f.userHome, ['alice']);
});

test('postremove repeats unit stops and reloads each active user manager', async t => {
  const f = await setup(t, {sessions:'1 1001 alice seat0 tty2 active'});
  const result = await f.invoke('postrm', 'remove');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = await readFile(f.systemctlLog, 'utf8');
  assert.match(calls, /--user -M alice@ stop faravan-app\.service faravan-coordinator\.service/);
  assert.match(calls, /--user -M alice@ daemon-reload/);
  await assertUserDataKept(f.userHome, ['alice']);
});

test('package removal leaves a same-channel unit with no install identity alone', async t => {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service';
  const f = await setup(t, {sessions:'4 1001 alice - - active',sbxUnits:`${mine} loaded active running x`});
  const evidence=join(f.root,'unit-evidence.alice');
  await writeFile(evidence,(await readFile(evidence,'utf8')).replace(/FARAVAN_SBXD_OWNER_ID=[0-9a-f]*/, 'FARAVAN_SBXD_OWNER_ID='));
  const result = await f.invoke('prerm','remove');
  assert.doesNotMatch(await readFile(f.systemctlLog,'utf8'),new RegExp(`stop ${mine}`));
  assert.match(result.stderr,/ownership|left alone/i);
});


test('removal refuses a reusable legacy unit name even if its final marker reads as ours', async t => {
  const unit='faravan-sbxd-aaaaaaaaaaaa.service';
  const f=await setup(t,{sessions:'1 1001 alice seat0 tty2 active',sbxUnits:unit+' loaded active running Faravan',ownedSbxUnits:unit});
  const result=await f.invoke('prerm','remove');
  const calls=await readFile(f.systemctlLog,'utf8');
  assert.equal(calls.includes(' stop '+unit),false);
  assert.notEqual(result.code,0);
});

test('fresh stable data home is resolved by the runtime when the app is stopped',async t=>{
  const own='faravan-sbxd-aaaaaaaaaaaa-'+'a'.repeat(64)+'.service';
  const f=await setup(t,{sessions:'1 1001 alice seat0 tty1 active',sbxUnits:own+' loaded active running Faravan'});
  const evidence=join(f.root,'unit-evidence.alice');
  const result=await f.invoke('prerm','remove');
  assert.equal(result.code,0,result.stderr);
  assert.match(await readFile(f.systemctlLog,'utf8'),new RegExp('stop '+own));
});
