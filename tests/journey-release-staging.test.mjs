import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageSignedRelease} from '../packaging/journey/stage-release.mjs';
import {UPDATE_PUBLIC_KEY} from '../lib/v1/update-key.mjs';

const execFile = promisify(execFileCallback);
const installerSource = fileURLToPath(new URL('../bin/faravan-install.sh', import.meta.url));

// The journey installs from file:// with only the tarball staged. The staged manifest must verify, so the installer
// gets past the signature check and into the install itself.
test('the journey stages a release the installer verifies, signed with a key made for the run', {timeout: 120000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'journey-staging-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bundle = join(root, 'bundle/usr/lib/faravan');
  await mkdir(join(bundle, 'runtime/bin'), {recursive: true});
  await mkdir(join(bundle, 'bin'), {recursive: true});
  await writeFile(join(bundle, 'runtime/bin/node'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(bundle, 'bin/faravan'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(bundle, 'VERSION'), '0.1.0\n');
  await chmod(join(bundle, 'runtime/bin/node'), 0o755);
  await chmod(join(bundle, 'bin/faravan'), 0o755);
  const media = join(root, 'media');
  await mkdir(media);
  await execFile('tar', ['-czf', join(media, 'faravan_linux_amd64.tar.gz'), '-C', join(root, 'bundle'), 'usr']);

  const staged = await stageSignedRelease({tarball: join(media, 'faravan_linux_amd64.tar.gz'), version: '0.1.0', media,
    installerSource, out: join(root, 'installer')});
  const embedded = (await readFile(staged.installer, 'utf8')).match(/^UPDATE_PUBLIC_KEY_PEM='([^']*)'/m);
  assert.ok(embedded);
  assert.notEqual(embedded[1] + '\n', UPDATE_PUBLIC_KEY, 'the staged installer trusts the run key, not the real update key');

  const home = join(root, 'home');
  await mkdir(home);
  const env = {...process.env, HOME: home, FARAVAN_CHANNEL: 'stable', FARAVAN_INSTALL_ROOT: join(root, 'local'),
    FARAVAN_DOWNLOAD_BASE: 'file://' + media, FARAVAN_RELEASE_API: 'file://' + join(root, 'no-release-api'),
    FARAVAN_APT_KEY_FPR: 'REPLACE_WITH_ARCHIVE_KEY_FINGERPRINT', FARAVAN_NO_TRAY_LAUNCH: '1', FARAVAN_NO_UPDATE: '1'};
  delete env.FARAVAN_ALLOW_UNVERIFIED;
  const result = await execFile('sh', [staged.installer], {env}).then(r => r, e => e);
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert.match(output, /Verified the tarball against the release's signed manifest\./);
  assert.doesNotMatch(output, /nothing was installed/);
  assert.equal(result.code ?? 0, 0, output);
});

// The journey must stage its signed release and run that staged installer. The real installer in the source tree is
// never run against the file:// media, because it would look for a manifest the journey does not publish.
test('the journey stages its signed release and installs with the staged installer copy', async () => {
  const journey = await readFile(fileURLToPath(new URL('../packaging/journey/new-user-journey.sh', import.meta.url)), 'utf8');
  assert.match(journey, /stage-release\.mjs/);
  assert.doesNotMatch(journey, /bash "\$SRC\/bin\/faravan-install\.sh"/);
  assert.equal(journey.match(/bash "\$RUN\/installer\/faravan-install\.sh"/g)?.length, 2, 'both installs run the staged copy');
});

for (const [name, entered, marker, stop, prior, launcherExists=true] of [
  ['never entered',false,false,0,0], ['owned coordinator',true,true,0,0],
  ['missing marker',true,false,0,0], ['missing launcher',true,true,0,0,false], ['failed stop',true,true,9,0],
  ['failed stop after earlier failure',true,true,9,7],
]) test('journey cleanup distinguishes '+name, async t => {
  const run = await mkdtemp(join(tmpdir(),'journey-stop-'));
  t.after(() => rm(run,{recursive:true,force:true}));
  const here = fileURLToPath(new URL('../packaging/journey',import.meta.url));
  const source = await readFile(join(here,'new-user-journey.sh'),'utf8');
  const trap = source.slice(source.indexOf('cleanup() {'),source.indexOf("trap 'exit 130' INT"));
  assert.ok(trap.includes('trap cleanup EXIT'));
  const launcher = join(run,'owner/home/.local/bin/faravan');
  const coordinator = join(run,'smoke/owner/coordinator');
  await mkdir(dirname(launcher),{recursive:true});
  await mkdir(coordinator,{recursive:true});
  if(entered)await writeFile(join(run,'smoke/started.owner.host'),'');
  if(marker)await writeFile(join(coordinator,'host.json'),'{}');
  if(launcherExists)await writeFile(launcher,'#!/bin/sh\n[ "$1" = host ] || exit 0\n[ "$FARAVAN_COORDINATOR_HOME" = "$EXPECT_COORDINATOR" ] || exit 12\necho host >> "$RUN/test-calls"\nexit '+stop+'\n',{mode:0o700});
  await writeFile(join(run,'summary.json'),JSON.stringify({journeyChecksPassed:true,steps:[]}));
  const bootstrap = join(run,'empty-proc.mjs');
  await writeFile(bootstrap,"import fs from 'node:fs'; const read=fs.readdirSync; fs.readdirSync=(p,...a)=>p==='/proc'?[]:read(p,...a);");
  const result = await execFile('bash',['-c','set -Eeuo pipefail\n'+trap+'\nexit '+prior],{timeout:10000,
    env:{...process.env,RUN:run,HERE:here,EXPECT_COORDINATOR:coordinator,NODE_OPTIONS:'--import='+bootstrap}}).then(x=>x,e=>e);
  const summary = JSON.parse(await readFile(join(run,'summary.json'),'utf8'));
  const attempted = marker && launcherExists;
  const pass = !prior && (!entered || attempted) && stop===0;
  assert.equal(result.code??0,prior || (pass?0:1),result.stderr);
  assert.equal(summary.pass,pass);
  assert.deepEqual(summary.steps.at(-1).stopOutcomes['owner:host'],{
    state:!entered?'not_needed':attempted&&!stop?'stopped':'unverified', exitCode:attempted?stop:null,
  });
  if(attempted)assert.equal(await readFile(join(run,'test-calls'),'utf8'),'host\n');
  else await assert.rejects(readFile(join(run,'test-calls')),{code:'ENOENT'});
  if(!pass)assert.doesNotMatch(result.stdout,/PASS journey/);
});

test('Debian graphical onboarding names Discover and matches the packaged Faravan launcher', async () => {
  const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [guide, packageSpec, desktop] = await Promise.all([
    readSource('docs/install.md'),
    readSource('packaging/nfpm.yaml'),
    readSource('packaging/assets/faravan.desktop'),
  ]);
  const graphical = guide.split('## Linux')[1]?.split('## After opening')[0];
  assert.ok(graphical, 'document the desktop package install');
  assert.match(graphical, /Download the `\.deb` for your release/);
  assert.match(graphical, /Discover/);
  assert.match(graphical, /password prompt/);
  assert.match(graphical, /Faravan.*applications menu/);
  assert.doesNotMatch(graphical, /curl|\bTerminal\b/);
  const exec = desktop.match(/^Exec=([\w-]+)$/m)?.[1];
  assert.match(desktop, /^Name=Faravan$/m);
  assert.ok(exec, 'desktop entry names a launcher');
  assert.ok(packageSpec.includes(`dst: /usr/bin/${exec}`), 'launcher is packaged');
  assert.ok(packageSpec.includes('dst: /usr/share/applications/faravan.desktop'), 'desktop entry is packaged');
});
