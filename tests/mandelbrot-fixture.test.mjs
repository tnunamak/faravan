import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FIXTURE, HEIGHT, WIDTH, pixels, png, render} from '../scripts/gen-mandelbrot-fixture.mjs';

test('the Mandelbrot preview fixture is the picture scripts/gen-mandelbrot-fixture.mjs draws', () => {
  const file = readFileSync(FIXTURE);
  assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(file.readUInt32BE(16), WIDTH);
  assert.equal(file.readUInt32BE(20), HEIGHT);
  assert.ok(pixels(file).equals(render()), 'regenerate with: node scripts/gen-mandelbrot-fixture.mjs');
  assert.ok(pixels(png()).equals(render()), 'the written file round-trips to the drawn pixels');
});
