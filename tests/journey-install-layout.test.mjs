import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {parsePreviewInstallChannel, resolveInstallLayout} from '../packaging/journey/install-layout.mjs';

const home = '/fixture/owner/home';
const previewRoot = '/fixture/preview/usr/lib/faravan';

test('no root override keeps every stable path, regardless of a stray node override', () => {
  const stableRoot = join(home, '.local', 'lib', 'faravan');
  assert.deepEqual(resolveInstallLayout({FARAVAN_NODE_BIN: '/wrong-node'}, home), {
    installRoot: stableRoot,
    nodeBin: join(stableRoot, 'runtime/bin/node'),
    channelFile: join(home, '.local', 'channel'),
    appModule: join(stableRoot, 'lib/v1/app.mjs'),
  });
});

test('preview resolves the installed tree and its default runtime, marker and module', () => {
  assert.deepEqual(resolveInstallLayout({FARAVAN_INSTALL_ROOT: previewRoot}, home), {
    installRoot: previewRoot,
    nodeBin: join(previewRoot, 'runtime/bin/node'),
    channelFile: join(previewRoot, 'channel.json'),
    appModule: join(previewRoot, 'lib/v1/app.mjs'),
  });
});

test('preview may point the probe at an exact Node binary without moving other files', () => {
  const base = resolveInstallLayout({FARAVAN_INSTALL_ROOT: previewRoot}, home);
  assert.deepEqual(resolveInstallLayout({
    FARAVAN_INSTALL_ROOT: previewRoot,
    FARAVAN_NODE_BIN: '/fixture/runtime/node',
  }, home), {...base, nodeBin: '/fixture/runtime/node'});
});

test('preview accepts its installed JSON marker, not the stable text marker', () => {
  assert.equal(parsePreviewInstallChannel('{"id":"preview-20261127.6","name":"Faravan Preview"}'), 'preview-20261127.6');
  assert.throws(() => parsePreviewInstallChannel('channel=preview'), /preview channel JSON/);
  assert.throws(() => parsePreviewInstallChannel('{"id":"stable"}'), /preview channel/);
});
