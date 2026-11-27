import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { appFixture } from './helpers/v1-app-fixture.mjs';

test('favicon and manifest are public with the correct content types', async t => {
  const fixture = await appFixture(t);
  const { app } = await fixture.start('icons');
  for (const [path, type] of [
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/vnd.microsoft.icon'],
    ['/manifest.webmanifest', 'application/manifest+json'],
  ]) {
    const response = await fetch(app.origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
  }
});

test('favicon.svg is the marigold open-horizon mark',async()=>{
  const svg=await readFile(new URL('../public/v1/favicon.svg',import.meta.url),'utf8');
  const source=await readFile(new URL('../ui/v1/public/favicon.svg',import.meta.url),'utf8');
  assert.equal(svg,source,'public/v1 and ui/v1/public ship the same favicon');
  assert.match(svg,/<svg[^>]*viewBox="0 0 64 64"/);
  assert.match(svg,/<title id="title">Faravan — Open horizon<\/title>/);
  assert.match(svg,/<path d="M16 32a16 16 0 0 1 32 0"\/>/);
  assert.match(svg,/<path d="M8 48h48"\/>/);
  assert.match(svg,/stroke="#ffb800" stroke-width="8"/);
});

test('favicon.ico contains the 32 px open-horizon mark',async()=>{
  const ico=await readFile(new URL('../public/v1/favicon.ico',import.meta.url));
  const source=await readFile(new URL('../ui/v1/public/favicon.ico',import.meta.url));
  assert.ok(ico.equals(source));
  assert.equal(ico.readUInt16LE(0),0);
  assert.equal(ico.readUInt16LE(2),1);
  const count=ico.readUInt16LE(4);
  assert.equal(count,1);
  assert.deepEqual([ico.readUInt8(6),ico.readUInt8(7)],[32,32]);
  const offset=ico.readUInt32LE(18);
  assert.equal(ico.readUInt32LE(offset),40,'payload is a BITMAPINFOHEADER');
  assert.deepEqual([ico.readInt32LE(offset+4),ico.readInt32LE(offset+8)],[32,64],'XOR and AND masks use a 32 by 32 frame');
  assert.deepEqual([ico.readUInt16LE(offset+12),ico.readUInt16LE(offset+14)],[1,32],'icon has one 32-bit color plane');
});
