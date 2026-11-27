import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeQr, qrPath, qrSvg } from '../lib/v1/qr.mjs';

// Reference matrices from an independent encoder (python-qrcode 8.x, byte mode, level M, forced mask), generated once and committed.
const cases = JSON.parse(await readFile(new URL('./fixtures/qr-reference.json', import.meta.url), 'utf8'));

for (const reference of cases) {
  test(`matches the reference encoder module for module: version ${reference.version}, mask ${reference.mask}`, () => {
    const rows = encodeQr(reference.text, {mask: reference.mask}).map(row => row.map(dark => dark ? '1' : '0').join(''));
    assert.deepEqual(rows, reference.rows);
  });
}

test('text longer than version 10 holds is refused, not silently truncated', () => {
  assert.throws(() => encodeQr('x'.repeat(214)), {code: 'qr_too_long'});
  assert.equal(encodeQr('x'.repeat(213)).length, 57);
});

test('the SVG has a quiet zone and black on white, and carries no script', () => {
  const svg = qrSvg('http://192.168.1.20:47321/');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  assert.equal(/script|on\w+=/i.test(svg), false);
});

test('the path form covers exactly the dark modules, for a UI to draw as data', () => {
  const text = 'http://192.168.1.20:47321/pair#K7QF2M9D', modules = encodeQr(text), {size, d} = qrPath(text);
  assert.equal(size, modules.length + 8);
  assert.equal(d.split('M').length - 1, modules.flat().filter(Boolean).length);
  assert.match(d, /^(M\d+ \d+h1v1h-1z)+$/);
});
