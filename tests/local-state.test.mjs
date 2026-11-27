import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import os, {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configHome, saveJsonFile} from '../lib/local-state.mjs';
import {channelDataHome} from '../lib/channel-identity.mjs';

test('non-stable channel data homes follow each OS data directory', () => {
  const channel = {id:'faravan', name:'Faravan', dataFolder:'Faravan', bundleId:'com.faravan.app', helperBundleId:'com.faravan.app.notify', launchAgentLabel:'com.faravan.agent', linuxPrefix:'faravan'};
  assert.equal(channelDataHome({channel, platform:'darwin', home:'/Users/test'}), '/Users/test/Library/Application Support/Faravan');
  assert.equal(channelDataHome({channel, platform:'linux', home:'/home/test', env:{}}), '/home/test/.local/share/Faravan');
  assert.equal(channelDataHome({channel, platform:'linux', home:'/home/test', env:{XDG_DATA_HOME:'/data'} }), '/data/Faravan');
  assert.equal(channelDataHome({channel, platform:'win32', home:'C:/Users/test', env:{LOCALAPPDATA:'C:/Users/test/AppData/Local'} }), 'C:\\Users\\test\\AppData\\Local\\Faravan');
  assert.equal(channelDataHome({channel:{id:'faravan', name:'Faravan', dataFolder:'Faravan', bundleId:'com.faravan.app', helperBundleId:'com.faravan.app.notify', launchAgentLabel:'com.faravan.agent', linuxPrefix:'faravan'}, platform:'linux', home:'/home/test', env:{}}), '/home/test/.local/share/Faravan');
  assert.equal(channelDataHome({channel, platform:'win32', home:'C:/Users/test', env:{LOCALAPPDATA:'relative\\data'}}), 'C:\\Users\\test\\AppData\\Local\\Faravan');
  assert.throws(() => channelDataHome({channel:{id:'preview', dataFolder:'Faravan'}, platform:'linux'}), /complete channel identity/);
});

test('local state respects FARAVAN_HOME at call time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-home-'));
  const prior = process.env.FARAVAN_HOME;
  try {
    process.env.FARAVAN_HOME = directory;
    assert.equal(configHome(), directory);
  } finally {
    if (prior === undefined) delete process.env.FARAVAN_HOME;
    else process.env.FARAVAN_HOME = prior;
    await rm(directory, {recursive:true, force:true});
  }
});

test('local JSON state creates private directories and replaces complete private files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-json-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'nested', 'state.json');
  saveJsonFile(file, {value:1}, {base:directory});
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'nested'))).mode & 0o777, 0o700);
  saveJsonFile(file, {value:2}, {base:directory});
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {value:2});
  saveJsonFile(file, {public:true}, {mode:0o644, base:directory});
  assert.equal((await stat(file)).mode & 0o777, 0o644);
});

test('local JSON state preserves prior contents and cleans up after file sync failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-sync-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'state.json');
  saveJsonFile(file, {value:'prior'}, {base:directory});
  const prior = await readFile(file, 'utf8');
  const failure = Object.assign(new Error('injected file sync failure'), {code:'EIO'});
  const originalSync = fs.fsyncSync;
  const sync = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isFile()) throw failure;
    return originalSync(fd);
  });
  try {
    assert.throws(() => saveJsonFile(file, {value:'next'}, {base:directory}), error => error === failure);
  } finally {
    sync.mock.restore();
  }
  assert.equal(await readFile(file, 'utf8'), prior);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('overlapping local JSON saves use different private same-directory temp files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-overlap-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'state.json');
  const rename = fs.renameSync;
  const temps = [];
  const hook = t.mock.method(fs, 'renameSync', (source, target) => {
    temps.push(source);
    assert.equal(join(source, '..'), directory);
    assert.equal(fs.statSync(source).mode & 0o777, 0o600);
    // Interleave a second save while the first still owns its temporary file.
    if (temps.length === 1) saveJsonFile(file, {value:'inner'}, {base:directory});
    return rename(source, target);
  });
  try {
    saveJsonFile(file, {value:'outer'}, {base:directory});
  } finally {
    hook.mock.restore();
  }
  assert.equal(temps.length, 2);
  assert.notEqual(temps[0], temps[1]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {value:'outer'});
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('local JSON state syncs and closes the file before rename, then syncs the directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-order-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const events = [];
  const sync = fs.fsyncSync;
  const close = fs.closeSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', fd => {
    events.push(fs.fstatSync(fd).isDirectory() ? 'sync directory' : 'sync file');
    return sync(fd);
  });
  t.mock.method(fs, 'closeSync', fd => {
    events.push(fs.fstatSync(fd).isDirectory() ? 'close directory' : 'close file');
    return close(fd);
  });
  t.mock.method(fs, 'renameSync', (...args) => {
    events.push('rename');
    return rename(...args);
  });
  saveJsonFile(join(directory, 'state.json'), {value:1}, {base:directory});
  assert.deepEqual(events.slice(-5), ['sync file', 'close file', 'rename', 'sync directory', 'close directory']);
  assert.ok(events.slice(0, -5).every((event, index) => event === (index % 2 ? 'close directory' : 'sync directory')));
});

test('local JSON directory sync propagates every failure after rename', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-state-dir-sync-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'state.json');
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  for (const code of ['EINVAL', 'EISDIR', 'EPERM', 'EIO']) {
    let renamed = false;
    const renameHook = t.mock.method(fs, 'renameSync', (...args) => {
      const result = rename(...args);
      renamed = true;
      return result;
    });
    const failure = Object.assign(new Error('injected ' + code), {code});
    const hook = t.mock.method(fs, 'fsyncSync', fd => {
      if (renamed && fs.fstatSync(fd).isDirectory()) throw failure;
      return sync(fd);
    });
    try {
      assert.throws(() => saveJsonFile(file, {code}, {base:directory}), error => error === failure);
    } finally {
      hook.mock.restore();
      renameHook.mock.restore();
    }
    // Rename has already committed even when directory durability is uncertain.
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {code});
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  }
});

