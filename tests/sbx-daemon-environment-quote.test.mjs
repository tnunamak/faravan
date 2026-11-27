import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialStoreEnv, isFaravanSbxDaemonUnit, sbxDaemonDescription, systemdEnvironmentValue, verifySbxDaemonUnitForRemoval } from '../lib/docker-backend.mjs';
import { systemdQuoteAssignment, systemdShowEnvironment } from './helpers/systemd-environment.mjs';

// `systemctl --user show -p Environment` quotes each whole assignment. A data folder with a space in it, which the
// default Linux preview profile has, therefore arrives as one double-quoted token.

const DATA_HOME = '/home/someone/.local/share/Faravan Preview 20261026';
const ROOT = '/opt/faravan install';
const HOME = '/home/someone/.wfsbx';
const OWNER_ID = createHash('sha256').update('quoted environment owner').digest('hex');
const EXECUTABLE = '/usr/local/bin/sbx';
const owner = { id: OWNER_ID, executable: EXECUTABLE };

function unit(overrides = {}) {
  const entries = [
    ...Object.entries(credentialStoreEnv(HOME, 'linux')),
    ['FARAVAN_SBXD_OWNER_ID', OWNER_ID], ['FARAVAN_SBXD_INSTALL_ROOT', ROOT], ['FARAVAN_SBXD_DATA_HOME', DATA_HOME],
  ];
  return {
    loadState: 'loaded', state: 'active', pid: 4242, invocationId: 'invocation', description: sbxDaemonDescription(),
    execStart: `{ path=${EXECUTABLE} ; argv[]=${EXECUTABLE} daemon start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }`,
    environment: systemdShowEnvironment(entries),
    ...overrides,
  };
}

test('the fixture helper writes the quoting systemd prints', () => {
  assert.equal(systemdQuoteAssignment('PATH', '/usr/bin:/bin'), 'PATH=/usr/bin:/bin');
  assert.equal(systemdQuoteAssignment('A', 'two words'), '"A=two words"');
  assert.equal(systemdQuoteAssignment('A', 'say "hi" \\ there'), '"A=say \\"hi\\" \\\\ there"');
  assert.equal(systemdQuoteAssignment('KWIN_DRM_DEVICES', '/dev/dri/by-path/pci-0000\\:01\\:00.0-card'), '"KWIN_DRM_DEVICES=/dev/dri/by-path/pci-0000\\\\:01\\\\:00.0-card"');
});

test('a quoted whole assignment with spaces reads back as its value', () => {
  const environment = `HOME=/home/someone/.wfsbx "FARAVAN_SBXD_DATA_HOME=${DATA_HOME}" LANG=C.UTF-8`;
  assert.equal(systemdEnvironmentValue(environment, 'FARAVAN_SBXD_DATA_HOME'), DATA_HOME);
  assert.equal(systemdEnvironmentValue(environment, 'HOME'), '/home/someone/.wfsbx');
  assert.equal(systemdEnvironmentValue(environment, 'LANG'), 'C.UTF-8');
});

test('unquoted assignments and several entries on one line each read back', () => {
  const environment = 'HOME=/home/someone XDG_STATE_HOME=/home/someone/.state PATH=/usr/bin:/bin';
  assert.equal(systemdEnvironmentValue(environment, 'HOME'), '/home/someone');
  assert.equal(systemdEnvironmentValue(environment, 'XDG_STATE_HOME'), '/home/someone/.state');
  assert.equal(systemdEnvironmentValue(environment, 'PATH'), '/usr/bin:/bin');
  assert.equal(systemdEnvironmentValue(environment, 'MISSING'), undefined);
});

test('an escaped quote, backslash, dollar or backtick inside a quoted entry is unescaped', () => {
  const environment = [
    systemdQuoteAssignment('QUOTED', 'say "hi" \\ there'),
    systemdQuoteAssignment('SHELLY', 'cost $5 `date`'),
    systemdQuoteAssignment('KWIN_DRM_DEVICES', '/dev/dri/by-path/pci-0000\\:01\\:00.0-card'),
  ].join(' ');
  assert.equal(systemdEnvironmentValue(environment, 'QUOTED'), 'say "hi" \\ there');
  assert.equal(systemdEnvironmentValue(environment, 'SHELLY'), 'cost $5 `date`');
  assert.equal(systemdEnvironmentValue(environment, 'KWIN_DRM_DEVICES'), '/dev/dri/by-path/pci-0000\\:01\\:00.0-card');
});

test('the value is everything after the first equals sign', () => {
  assert.equal(systemdEnvironmentValue('"A=b=c d"', 'A'), 'b=c d');
  assert.equal(systemdEnvironmentValue('A=b=c', 'A'), 'b=c');
});

test('a name inside another entry value is not an entry', () => {
  const environment = '"A=x FARAVAN_SBXD_DATA_HOME=/foreign"';
  assert.equal(systemdEnvironmentValue(environment, 'FARAVAN_SBXD_DATA_HOME'), undefined);
  assert.equal(systemdEnvironmentValue(environment, 'A'), 'x FARAVAN_SBXD_DATA_HOME=/foreign');
});

test('the older NAME="value" form still reads back', () => {
  assert.equal(systemdEnvironmentValue('A="two words" B=plain', 'A'), 'two words');
  assert.equal(systemdEnvironmentValue('A="two words" B=plain', 'B'), 'plain');
});

test('an unterminated quote reads as nothing, for every name', () => {
  const environment = 'HOME=/home/someone "FARAVAN_SBXD_DATA_HOME=/half open';
  assert.equal(systemdEnvironmentValue(environment, 'FARAVAN_SBXD_DATA_HOME'), undefined);
  assert.equal(systemdEnvironmentValue(environment, 'HOME'), undefined, 'one unreadable token makes the whole line unreadable');
});

test('our unit is recognized when the data folder has a space', () => {
  assert.equal(isFaravanSbxDaemonUnit(unit(), HOME, { owner, dataHome: DATA_HOME, root: ROOT }), true);
});

test('the same unit is still refused for another data folder, another root, or another owner', () => {
  assert.equal(isFaravanSbxDaemonUnit(unit(), HOME, { owner, dataHome: '/home/someone/.local/share/Faravan Other', root: ROOT }), false);
  assert.equal(isFaravanSbxDaemonUnit(unit(), HOME, { owner, dataHome: DATA_HOME, root: '/opt/elsewhere' }), false);
  assert.equal(isFaravanSbxDaemonUnit(unit(), HOME, { owner: { ...owner, id: 'f'.repeat(64) }, dataHome: DATA_HOME, root: ROOT }), false);
});

test('a quoted token cannot smuggle in a name the unit does not allow', () => {
  const entries = [...Object.entries(credentialStoreEnv(HOME, 'linux')), ['FARAVAN_SBXD_OWNER_ID', OWNER_ID], ['FARAVAN_SBXD_INSTALL_ROOT', ROOT]];
  const smuggled = `${systemdShowEnvironment(entries)} "FARAVAN_SBXD_DATA_HOME=${DATA_HOME}" "GITHUB_TOKEN=x"`;
  assert.equal(isFaravanSbxDaemonUnit(unit({ environment: smuggled }), HOME, { owner, dataHome: DATA_HOME, root: ROOT }), false);
  const duplicate = `${unit().environment} "FARAVAN_SBXD_DATA_HOME=${DATA_HOME}"`;
  assert.equal(isFaravanSbxDaemonUnit(unit({ environment: duplicate }), HOME, { owner, dataHome: DATA_HOME, root: ROOT }), false);
  const unterminated = `${unit().environment} "A=open`;
  assert.equal(isFaravanSbxDaemonUnit(unit({ environment: unterminated }), HOME, { owner, dataHome: DATA_HOME, root: ROOT }), false);
});

test('uninstall verification recognizes our unit when the data folder has a space', () => {
  const dataHome = mkdtempSync(join(tmpdir(), 'faravan preview '));
  try {
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, `sbx-daemon-owner-${createHash('sha256').update(ROOT).digest('hex')}.json`), JSON.stringify(owner));
    const name = `faravan-sbxd-${createHash('sha256').update(HOME).digest('hex').slice(0, 12)}-${OWNER_ID}.service`;
    const entries = [
      ...Object.entries(credentialStoreEnv(HOME, 'linux')),
      ['FARAVAN_SBXD_OWNER_ID', OWNER_ID], ['FARAVAN_SBXD_INSTALL_ROOT', ROOT], ['FARAVAN_SBXD_DATA_HOME', dataHome],
    ];
    const info = unit({ environment: systemdShowEnvironment(entries) });
    assert.equal(verifySbxDaemonUnitForRemoval(info, name, { dataHome, root: ROOT }), true);
    assert.equal(verifySbxDaemonUnitForRemoval(info, name, { dataHome: dataHome + ' other', root: ROOT }), false);
  } finally { rmSync(dataHome, { recursive: true, force: true }); }
});
