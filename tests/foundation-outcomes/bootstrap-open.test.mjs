import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, chmod, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const execFile = promisify(callback);
const source = await readFile(new URL('../../bin/faravan-install.sh', import.meta.url), 'utf8');

// Exercise actual shell control flow, replacing only external effects. This is
// not signature qualification or W02: no signing, downloads or host intervention.
// Integration dependency: fv-outcome-linux-user-download-1114.
function shellFunction(name) {
  const start = source.indexOf(name + '() {\n');
  assert.notEqual(start, -1, name + ' must exist');
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, name + ' must end');
  return source.slice(start, end + 3);
}
const common = `
set -eu
say() { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*" >&2; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
`;
async function fixture(t, {failOpen = false, desktop = true, failMenu = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-bootstrap-open-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bundle = join(root, 'bundle');
  await mkdir(join(bundle, 'usr/bin'), {recursive: true});
  await mkdir(join(bundle, 'usr/lib/faravan/runtime/bin'), {recursive: true});
  const executable = async (path, body) => {
    await writeFile(path, '#!/bin/sh\n' + body + '\n');
    await chmod(path, 0o755);
  };
  await executable(join(bundle, 'usr/bin/faravan'),
    'printf "launch-observed\\n"\n[ "$FAIL_OPEN" = no ]');
  await executable(join(bundle, 'usr/lib/faravan/runtime/bin/node'), 'exit 0');
  await writeFile(join(bundle, 'usr/lib/faravan/.installed-via'), 'tarball\n');
  const script = join(root, 'run.sh');
  await writeFile(script, common + `
plain_path() { return 0; }
path_exists() { [ -e "$1" ] || [ -L "$1" ]; }
verify_signed_manifest() { printf 'verify-manifest\\n'; manifest=fixture; }
download() { printf 'download-fixture\\n'; }
check_release_file() { printf 'verify-bytes\\n'; }
python3() {
  if [ "$5" = preview-url ]; then
    printf 'https://fixture.invalid/archive\\npreview-fixture\\n0.4.0\\n'
  else
    printf 'faravan-preview-fixture\\nFaravan Fixture\\n'
  fi
}
tar() { cp -R "$BUNDLE"/. "$4"; }
install_menu_entry() {
  [ "$FAIL_MENU" = no ] || return 1
  printf 'fixture menu\\n' > "$HOME/menu"
}
record_install_run() { printf 'record:%s\\n' "$1"; }
RELEASE_CHECK_PY=fixture
CHANNEL_CHECK_PY=fixture
MIN_INSTALL_VERSION=0.4.0
FEED_URL=https://fixture.invalid/feed
` + shellFunction('install_preview') + '\ninstall_preview\n');
  const env = {PATH: process.env.PATH, HOME: root, TMP_DIR: root,
    XDG_DATA_HOME: join(root, 'data'), BUNDLE: bundle,
    FAIL_OPEN: failOpen ? 'yes' : 'no', FAIL_MENU: failMenu ? 'yes' : 'no',
    ...(desktop ? {WAYLAND_DISPLAY: 'fixture'} : {})};
  const result = await execFile('/bin/sh', [script], {env})
    .then(r => ({code: 0, out: r.stdout + r.stderr}),
      e => ({code: e.code, out: (e.stdout ?? '') + (e.stderr ?? '')}));
  return {...result, root, target: join(root, 'data/faravan-preview-fixture')};
}

test('failed first open never emits final success or successful install telemetry', async t => {
  const f = await fixture(t, {failOpen: true});
  assert.notEqual(f.code, 0, f.out);
  assert.match(f.out, /launch-observed/);
  assert.match(f.out, /but it did not open/);
  assert.doesNotMatch(f.out, /Installed Faravan in|record:ok|Open Faravan from your applications menu/);
  assert.ok((await stat(f.target)).isDirectory(), 'existing retained-install semantics');
  assert.equal(await readFile(join(f.root, 'menu'), 'utf8'), 'fixture menu\n');
});

test('success follows the observed launch and preserves trust-check ordering', async t => {
  const f = await fixture(t);
  assert.equal(f.code, 0, f.out);
  assert.ok(f.out.indexOf('verify-manifest') < f.out.indexOf('download-fixture'));
  assert.ok(f.out.indexOf('verify-bytes') < f.out.indexOf('launch-observed'));
  assert.ok(f.out.indexOf('Installed Faravan in') > f.out.indexOf('launch-observed'));
  assert.ok(f.out.indexOf('record:ok') > f.out.indexOf('launch-observed'));
});

test('headless staging is truthful, not successful first-open evidence', async t => {
  const f = await fixture(t, {desktop: false});
  assert.equal(f.code, 0, f.out);
  assert.match(f.out, /first open has not been verified/);
  assert.doesNotMatch(f.out, /launch-observed|Installed Faravan in|record:ok/);
});

test('menu failure still rolls back the newly installed tree', async t => {
  const f = await fixture(t, {failMenu: true});
  assert.notEqual(f.code, 0);
  await assert.rejects(stat(f.target), {code: 'ENOENT'});
  assert.doesNotMatch(f.out, /launch-observed|Installed Faravan in|record:ok/);
});

test('missing supported dependencies refuse before runnable copy, without root repair', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-bootstrap-dependencies-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const missing of ['python3', 'curl', 'tar', 'openssl', 'base64']) {
    const script = join(root, missing + '.sh');
    await writeFile(script, common + `
need() { printf 'need:%s\\n' "$1"; [ "$1" != "$MISSING" ] || die "missing:$1"; }
sudo() { printf 'ROOT-INTERVENTION\\n'; exit 99; }
computer_ok() { say "$*"; }
computer_note() { say "$*"; }
computer_problem() { die "$*"; }
CHANNEL=preview
arch=x86_64
COMPUTER_PROBLEMS=
` + shellFunction('preflight_linux_dependencies') + '\n' + shellFunction('check_linux') + '\ncheck_linux\n');
    const r = await execFile('/bin/sh', [script], {env: {PATH: process.env.PATH, MISSING: missing}})
      .then(v => ({code: 0, out: v.stdout}), e => ({code: e.code, out: e.stdout + e.stderr}));
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp('missing:' + missing));
    assert.doesNotMatch(r.out, /This computer can run|ROOT-INTERVENTION/);
  }
});
