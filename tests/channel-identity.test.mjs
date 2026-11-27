import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelDataHome, channelIdentity } from '../lib/channel-identity.mjs';

test('missing and stable channel metadata preserve the stable profile', () => {
  const stable = channelIdentity('/no-installed-channel/lib/local-state.mjs');
  assert.equal(stable.id, 'faravan');
  assert.equal(channelDataHome({ channel: stable, home: '/Users/a', platform: 'darwin' }), '/Users/a/Library/Application Support/Faravan');
});

test('channel metadata is found beside installed app code and selects each OS data folder', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'faravan-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = path.join(root, 'Contents/Resources/faravan/lib');
  await mkdir(code, { recursive: true });
  await writeFile(path.join(root, 'Contents/Resources/faravan/channel.json'), JSON.stringify({ id: 'faravan', name: 'Faravan', dataFolder: 'Faravan', bundleId:'com.faravan.app', helperBundleId:'com.faravan.app.notify', launchAgentLabel:'com.faravan.agent', linuxPrefix:'faravan' }));
  const channel = channelIdentity(path.join(code, 'local-state.mjs'));
  assert.equal(channel.id, 'faravan');
  assert.equal(channelDataHome({ channel, home: '/Users/a', platform: 'darwin' }), '/Users/a/Library/Application Support/Faravan');
  assert.equal(channelDataHome({ channel, home: '/home/a', platform: 'linux', env: {} }), '/home/a/.local/share/Faravan');
  assert.equal(channelDataHome({ channel, home: 'C:\\Users\\a', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }), 'C:\\Users\\a\\AppData\\Local\\Faravan');
});

test('a channel.json above the app root is ignored', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'faravan-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = path.join(root, 'Contents/Resources/faravan/lib');
  await mkdir(code, { recursive: true });
  await writeFile(path.join(root, 'channel.json'), JSON.stringify({ id: 'stray', dataFolder: 'Stray' }));
  await writeFile(path.join(root, 'Contents/Resources/channel.json'), JSON.stringify({ id: 'stray', dataFolder: 'Stray' }));
  assert.equal(channelIdentity(path.join(code, 'local-state.mjs')).id, 'faravan');
});

test('JS and Go channel fixture contract rejects malformed identity and path fields', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/channel-identity-fixtures.json', import.meta.url), 'utf8'));
  for (const {name, valid, channel} of fixtures) {
    const root = await mkdtemp(path.join(tmpdir(), 'faravan-channel-contract-'));
    try {
      const modulePath = path.join(root, 'lib', 'identity.mjs');
      await mkdir(path.dirname(modulePath), {recursive:true});
      await writeFile(path.join(root, 'channel.json'), JSON.stringify(channel));
      if (valid) {
        assert.equal(channelIdentity(modulePath).id, 'faravan', name);
      } else {
        assert.throws(() => channelIdentity(modulePath), name);
      }
    } finally {
      await rm(root, {recursive:true, force:true});
    }
  }
});

test('channel data folder ignores relative XDG_DATA_HOME and honors explicit absolute data folder', () => {
  const channel = {id:'preview', name:'Preview', dataFolder:'Preview', bundleId:'com.example.preview', helperBundleId:'com.example.preview.notify', launchAgentLabel:'com.example.preview.agent', linuxPrefix:'preview'};
  assert.equal(channelDataHome({channel, platform:'linux', home:'/home/test', env:{XDG_DATA_HOME:'relative'}}), '/home/test/.local/share/Preview');
  assert.equal(channelDataHome({channel, platform:'linux', home:'/home/test', env:{FARAVAN_DATA_HOME:'/resolved/data/Preview', XDG_DATA_HOME:'/ignored'}}), '/resolved/data/Preview');
  assert.equal(channelDataHome({channel, platform:'win32', home:'C:/Users/test', env:{LOCALAPPDATA:'C:/Data'}}), 'C:\\Data\\Preview');
  for (const LOCALAPPDATA of ['relative\\data', 'C:drive-relative']) {
    assert.equal(channelDataHome({channel, platform:'win32', home:'C:/Users/test', env:{LOCALAPPDATA}}), 'C:\\Users\\test\\AppData\\Local\\Preview');
  }
  assert.equal(channelDataHome({channel, platform:'win32', home:'C:/Users/test', env:{}}), 'C:\\Users\\test\\AppData\\Local\\Preview');
});

test('Windows LOCALAPPDATA uses the shared drive-qualified path acceptance vectors', () => {
  const channel = {id:'preview', name:'Preview', dataFolder:'Preview', bundleId:'com.example.preview', helperBundleId:'com.example.preview.notify', launchAgentLabel:'com.example.preview.agent', linuxPrefix:'preview'};
  const home = 'C:/Users/review';
  const fallback = 'C:\\Users\\review\\AppData\\Local';
  const vectors = [
    ['rooted backslash', '\\Data', false],
    ['rooted slash', '/Data', false],
    ['drive-relative', 'C:Data', false],
    ['ordinary relative', 'relative\\data', false],
    ['drive-absolute', 'C:\\Data', true],
    ['UNC absolute', '\\\\server\\share\\data', true],
    ['slash UNC absolute', '//server/share/data', true],
    ['malformed UNC without share', '\\\\server', false],
  ];
  for (const [name, localAppData, accepted] of vectors) {
    const got = channelDataHome({channel, platform:'win32', home, env:{LOCALAPPDATA:localAppData}});
    const want = path.win32.join(accepted ? localAppData : fallback, 'Preview');
    assert.equal(got, want, name);
  }
});
