import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeFromHash } from '../ui/v1/src/helpers.mjs';

// A concatenated identifier is part of the route, not a standalone page link.
// Keep bare prefixes in the scan so a digest-less link still fails.
function trayHashes(source) {
  // ReviewRoute is a named prefix; inspect its identifier-appending use too.
  source = source.replace(/const (\w+) = "(#\/[^"]*)"/g, (declaration, name, hash) =>
    source.includes(name + ' + url.PathEscape(') ? declaration.replace(hash, hash + 'example-id') : declaration);
  return [...source.matchAll(/"(#\/[^"\n]*)"/g)].map(match => {
    const tail = source.slice(match.index + match[0].length);
    return /^\s*\+\s*url\.PathEscape\(/.test(tail) ? match[1] + 'example-id' : match[1];
  });
}

// Every page the tray opens must be a route the web app knows; the app shows "page not found" for any other.
test('the tray opens only routes the web app recognizes', async () => {
  const files = ['actions.go', 'notify.go'].map(name => 'tray/internal/faravantray/' + name);
  const hashes = new Set();
  for (const file of files) for (const hash of trayHashes(await readFile(file, 'utf8'))) hashes.add(hash);
  assert.ok(hashes.size >= 5, 'found the routes in the tray source: ' + [...hashes].join(' '));
  for (const hash of hashes) assert.notEqual(routeFromHash(hash).page, 'not-found', hash + ' is not a route of the web app');
});

test('tray route scan distinguishes dynamic identifiers from digest-less job links', () => {
  for (const source of ['route := "#/job/"', 'return "#/job/"', 'route := "#/job/" + ""']) {
    assert.equal(routeFromHash(trayHashes(source)[0]).page, 'not-found', source);
  }
  assert.equal(routeFromHash(trayHashes('route := "#/job/" + url.PathEscape(job.Digest)')[0]).page, 'job');
});
