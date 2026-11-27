import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';

// bin/faravan is a script, so its probe is run from source against fake sockets. The fake follows what macOS does: a listen
// on 0.0.0.0 succeeds while another process holds the same port on 127.0.0.1. A wildcard holder blocks any bind.
const file = path.join(process.cwd(), 'bin/faravan');
const source = fs.readFileSync(file, 'utf8');
const realRequire = createRequire(import.meta.url);
const PORT = 8787;

function fakeNet(heldHost) {
  const open = new Set();
  return {open, createServer() {
    const server = new EventEmitter();
    server.listen = ({host, port}, ready) => {
      queueMicrotask(() => {
        if (port === PORT && heldHost && (host === heldHost || heldHost === '0.0.0.0')) return server.emit('error', Object.assign(new Error('busy'), {code: 'EADDRINUSE'}));
        open.add(server); ready();
      });
      return server;
    };
    server.close = done => { open.delete(server); queueMicrotask(() => done?.()); return server; };
    return server;
  }};
}

function probeFor(net) {
  const mod = {exports: {}};
  const requireFake = id => id === 'node:net' ? net : realRequire(id);
  requireFake.main = null;
  vm.runInNewContext(source + '\nmodule.exports.localPortInUse = localPortInUse;', {require: requireFake, module: mod, exports: mod.exports,
    __dirname: path.dirname(file), __filename: file, process: {platform: 'darwin', env: {}, argv: []}, setTimeout, clearTimeout}, {filename: file});
  return mod.exports.localPortInUse;
}

test('a coordinator holding 127.0.0.1:port makes the port in use, even where a wildcard listen succeeds', async () => {
  const net = fakeNet('127.0.0.1');
  assert.equal(await probeFor(net)(PORT), true);
  assert.equal(net.open.size, 0, 'no probe socket is left open');
});

test('a wildcard holder makes the port in use', async () => {
  assert.equal(await probeFor(fakeNet('0.0.0.0'))(PORT), true);
});

test('a free port is free, and every probe socket is closed', async () => {
  const net = fakeNet(null);
  assert.equal(await probeFor(net)(PORT), false);
  assert.equal(net.open.size, 0);
});
