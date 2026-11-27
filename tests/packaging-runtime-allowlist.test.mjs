import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
test('staged qualification ignores unrelated modules and still checks product imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-stage-allow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['lib/v1/app.mjs', 'lib/executor.mjs', 'lib/docker-backend.mjs',
    'kits/wf-gh-cli/spec.yaml', 'kits/wf-claude-account/spec.yaml', 'kits/wf-pi/spec.yaml', 'kits/wf-pi/faravan-pi.sh', 'kits/wf-pi/files/home/.faravan/install-pi.sh', 'kits/wf-pi/files/home/.faravan/pi-payload.tgz', 'kits/wf-pi/files/home/.faravan/pi-payload.sha256', 'profiles/faravan-docker.json',
    'public/v1/index.html', 'public/v1/app.mjs', 'public/v1/app.css']) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, name.endsWith('.json') ? '{}' : name.endsWith('.sha256') ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  pi-payload.tgz\n' : '');
  }
  // The pin module reads its JSON beside itself, so the stage needs the real pair.
  for (const name of ['lib/sbx-image-pins.mjs', 'lib/sbx-image-pins.json']) await copyFile(join(repo, name), join(root, name));
  await writeFile(join(root, 'lib/unrelated.mjs'), 'throw Error("qualification traversed an unrelated module");');
  const checker = new URL('../packaging/check-staged-runtime.mjs', import.meta.url);
  const args = [checker.pathname, root];
  assert.match((await run(process.execPath, args)).stdout, /entrypoints: ok/);
  await writeFile(join(root, 'lib/executor.mjs'), 'throw Error("required product import failed");');
  await assert.rejects(run(process.execPath, args), error => error.stderr.includes('required product import failed'));
  await writeFile(join(root, 'lib/executor.mjs'), '');
  await writeFile(join(root, 'kits/wf-pi/files/home/.faravan/pi-payload.tgz'), 'tampered');
  await assert.rejects(run(process.execPath, args), error => error.stderr.includes('does not match pi-payload.sha256'));
});

test('staged qualification loads the agent image pins from the staged module and fails without the pin file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-stage-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['lib/v1/app.mjs', 'lib/executor.mjs', 'lib/docker-backend.mjs',
    'kits/wf-gh-cli/spec.yaml', 'kits/wf-claude-account/spec.yaml', 'kits/wf-pi/spec.yaml', 'kits/wf-pi/faravan-pi.sh', 'kits/wf-pi/files/home/.faravan/install-pi.sh', 'kits/wf-pi/files/home/.faravan/pi-payload.tgz', 'kits/wf-pi/files/home/.faravan/pi-payload.sha256', 'profiles/faravan-docker.json',
    'public/v1/index.html', 'public/v1/app.mjs', 'public/v1/app.css']) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, name.endsWith('.json') ? '{}' : name.endsWith('.sha256') ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  pi-payload.tgz\n' : '');
  }
  await copyFile(join(repo, 'lib/sbx-image-pins.mjs'), join(root, 'lib/sbx-image-pins.mjs'));
  const args = [fileURLToPath(new URL('../packaging/check-staged-runtime.mjs', import.meta.url)), root];
  // Module staged, pin file not: the default-path load must fail the qualification.
  await assert.rejects(run(process.execPath, args), error => /sbx-image-pins\.json/.test(error.stderr));
  // A pin file without a digest for a shipped agent fails too.
  const good = JSON.parse(await (await import('node:fs/promises')).readFile(join(repo, 'lib/sbx-image-pins.json'), 'utf8'));
  good.agents.codex = null; good.unpinned = { ...good.unpinned, codex: 'test' };
  await writeFile(join(root, 'lib/sbx-image-pins.json'), JSON.stringify(good));
  await assert.rejects(run(process.execPath, args), error => /codex/.test(error.stderr));
  await copyFile(join(repo, 'lib/sbx-image-pins.json'), join(root, 'lib/sbx-image-pins.json'));
  assert.match((await run(process.execPath, args)).stdout, /entrypoints: ok/);
});

test('prebuilt Linux pi payload staging accepts only pinned bytes on every build host', async t => {
  const {createHash} = await import('node:crypto');
  const {readFile, chmod, access} = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'faravan-prebuilt-pi-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const tree = join(root, 'source'), tools = join(root, 'tools');
  for (const dir of ['packaging','scripts','bin','lib','kits/wf-pi/files/home/.faravan',
    'docs/protocol','docs/security','profiles','public']) await mkdir(join(tree,dir),{recursive:true});
  await mkdir(tools);
  for (const name of ['packaging/stage-app.sh','packaging/check-staged-runtime.mjs'])
    await copyFile(join(repo,name),join(tree,name));
  for (const name of ['package.json','package-lock.json','profiles/faravan-docker.json',
    'docs/security/credential-proxy-evidence.json']) await writeFile(join(tree,name),'{}');
  await writeFile(join(tree,'LICENSE.md'),'fixture');
  const bytes=Buffer.from('synthetic pinned Linux guest payload');
  const payload=join(root,'prebuilt with spaces.tgz');
  await writeFile(payload,bytes);
  const pin=join(tree,'kits/wf-pi/files/home/.faravan/pi-payload.sha256');
  await writeFile(pin,createHash('sha256').update(bytes).digest('hex')+'  pi-payload.tgz\n');
  // Neither staging path may invoke npm online or rebuild on simulated Darwin.
  await writeFile(join(tools,'npm'),'#!/bin/sh\nexit 0\n');await chmod(join(tools,'npm'),0o755);
  await writeFile(join(tools,'uname'),'#!/bin/sh\nprintf "%s\\n" "$FIXTURE_OS"\n');await chmod(join(tools,'uname'),0o755);
  await writeFile(join(tree,'scripts/build-pi-payload.sh'),
    '#!/bin/sh\n[ "$FIXTURE_OS" = Linux ] && [ "$1" = --check ] || exit 99\ncp "$FIXTURE_PAYLOAD" "$2"\n');
  const env={...process.env,PATH:tools+':'+process.env.PATH,FIXTURE_OS:'Darwin',
    FARAVAN_REFRESH_PRICES:'0',FIXTURE_PAYLOAD:payload};
  delete env.FARAVAN_PI_PAYLOAD;
  const stage=(dest,extra={})=>run('bash',[join(tree,'packaging/stage-app.sh'),dest,'0.1.0'],{env:{...env,...extra}});
  const installed=dest=>join(dest,'kits/wf-pi/files/home/.faravan/pi-payload.tgz');
  const good=join(root,'good');
  await stage(good,{FARAVAN_PI_PAYLOAD:payload});
  assert.deepEqual(await readFile(installed(good)),bytes);
  const absent=join(root,'no-input');
  await assert.rejects(stage(absent),error=>error.stderr.includes('FARAVAN_PI_PAYLOAD'));
  await assert.rejects(access(absent),'missing input must fail before staging');
  const missing=join(root,'missing');
  await assert.rejects(stage(missing,{FARAVAN_PI_PAYLOAD:join(root,'absent.tgz')}),
    error=>error.stderr.includes('pi payload')&&error.stderr.includes('missing'));
  await assert.rejects(access(missing));
  const bad=join(root,'mismatch');
  await writeFile(payload,'wrong bytes');
  await assert.rejects(stage(bad,{FARAVAN_PI_PAYLOAD:payload}),
    error=>error.stderr.includes('does not match pi-payload.sha256'));
  await assert.rejects(access(bad));
  await writeFile(payload,bytes);
  const linux=join(root,'linux');
  await stage(linux,{FIXTURE_OS:'Linux'});
  assert.deepEqual(await readFile(installed(linux)),bytes);
});
