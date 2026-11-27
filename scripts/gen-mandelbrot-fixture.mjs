#!/usr/bin/env node
// Draws ui/v1/src/fixtures/mandelbrot.png, the preview image the result-view browser specs serve.
// The image is made here, from a formula, so its provenance is this file: no third-party artwork.
// Usage: node scripts/gen-mandelbrot-fixture.mjs [--check]   (--check fails when the committed PNG differs)
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32, deflateSync, inflateSync} from 'node:zlib';

export const WIDTH = 480, HEIGHT = 320;
export const FIXTURE = fileURLToPath(new URL('../ui/v1/src/fixtures/mandelbrot.png', import.meta.url));
const BANDS = [[24, 18, 54], [64, 40, 116], [122, 52, 150], [196, 72, 128], [244, 120, 84], [255, 186, 72], [255, 232, 140]];

// Raw RGB scanlines with a leading filter byte of 0 on each row, as PNG stores them before compression.
export function render() {
  const rows = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (1 + WIDTH * 3);
    for (let x = 0; x < WIDTH; x++) {
      const cr = -2.1 + (x / WIDTH) * 3.2, ci = -0.8 + (y / HEIGHT) * 1.6;
      let zr = 0, zi = 0, n = 0;
      while (n < 120 && zr * zr + zi * zi <= 4) { [zr, zi] = [zr * zr - zi * zi + cr, 2 * zr * zi + ci]; n++; }
      const colour = n === 120 ? [8, 6, 20] : BANDS[Math.floor(n / 3) % BANDS.length];
      rows.set(colour, row + 1 + x * 3);
    }
  }
  return rows;
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
export function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(render(), {level: 9})), chunk('IEND', Buffer.alloc(0))]);
}
// The pixels of a PNG file written by png(), for comparing without depending on compressor output.
export function pixels(file) {
  const parts = [];
  for (let at = 8; at < file.length;) {
    const size = file.readUInt32BE(at), type = file.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') parts.push(file.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  return inflateSync(Buffer.concat(parts));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check') {
    if (!pixels(readFileSync(FIXTURE)).equals(render())) { console.error('mandelbrot.png differs from this generator'); process.exitCode = 1; }
  } else writeFileSync(FIXTURE, png());
}
