import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { ArchiveError, validateArchive } from '../lib/archive.mjs';
import { prepareResultDownload } from '../lib/v1/result-download.mjs';

function member(name, content = 'x') {
  const h = Buffer.alloc(512), data = Buffer.from(content);
  h.write(name, 0, 100, 'utf8');
  const octal = (value, start, width) => h.write(value.toString(8).padStart(width - 1, '0') + '\0', start, width, 'ascii');
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(data.length, 124, 12); octal(0, 136, 12);
  h.fill(32, 148, 156); h.write('0', 156, 1); h.write('ustar\0', 257, 6); h.write('00', 263, 2);
  h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([h, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const tar = name => Buffer.concat([member(name), Buffer.alloc(1024)]);
const BAD = ['evil\u202egpj.exe', 'a\u2066b.txt', 'dir/\u200bhidden.txt', 'a\ufeffbom.txt', 'x\u2028y.txt', 'soft\u00adhyphen.txt', 'tag\u{E0041}.txt'];
const FINE = ['plain.txt', 'caf\u00e9.txt', '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.txt', 'family\u{1F468}\u200d\u{1F469}.txt', '\u65e5\u672c\u8a9e.md'];

test('L9: archive validation rejects bidi controls and other format characters in names', () => {
  for (const name of BAD)
    assert.throws(() => validateArchive(tar(name)), e => e instanceof ArchiveError && e.code === 'path_traversal', JSON.stringify(name));
  for (const name of FINE) validateArchive(tar(name));
});

test('L9: the result ZIP path rejects such names and still accepts ordinary international ones', async () => {
  const options = {mediaType: 'application/gzip', jobId: 'sha256:' + 'a'.repeat(64)};
  for (const name of BAD) await assert.rejects(prepareResultDownload(gzipSync(tar(name)), options), JSON.stringify(name));
  for (const name of FINE) assert.equal((await prepareResultDownload(gzipSync(tar(name)), options)).contentType, 'application/zip');
});
