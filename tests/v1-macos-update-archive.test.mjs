import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import { validateMacAppZip, MacAppZipError, MAC_ZIP_REASONS } from '../lib/v1/macos-update-archive.mjs';

// Synthetic container fixtures only. No native extractor, codesign, subprocess,
// filesystem, real app archive, network or extra fixture dependency.
const R = 'Faravan.app';
const regular = 0o100644, directory = 0o040755, symlink = 0o120777;
function crc32(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function field(id, data) {
  const head = Buffer.alloc(4); head.writeUInt16LE(id); head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}
function zip64Sizes(u, c) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(u)); b.writeBigUInt64LE(BigInt(c), 8);
  return field(1, b);
}
function unicodeName(raw, effective) {
  const b = Buffer.alloc(5); b[0] = 1; b.writeUInt32LE(crc32(raw), 1);
  return field(0x7075, Buffer.concat([b, Buffer.from(effective)]));
}
function zip(records, { count = records.length } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const r of records) {
    const data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data ?? '');
    const name = Buffer.from(r.name), localName = Buffer.from(r.localName ?? r.name);
    const method = r.method ?? 0;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const flags = r.flags ?? (0x800 | (r.descriptor ? 8 : 0));
    const declared = r.size ?? data.length, compressed = r.compressedSize ?? packed.length;
    const crc = r.crc ?? crc32(data);
    const wide = Boolean(r.zip64);
    const cx = r.extra ?? (wide ? zip64Sizes(declared, compressed) : Buffer.alloc(0));
    const lx = r.localExtra ?? (wide ? zip64Sizes(r.descriptor ? 0 : declared, r.descriptor ? 0 : compressed) : cx);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(wide ? 45 : 20, 4);
    local.writeUInt16LE(r.localFlags ?? flags, 6);
    local.writeUInt16LE(r.localMethod ?? method, 8);
    local.writeUInt32LE(r.localCrc ?? (r.descriptor ? 0 : crc), 14);
    local.writeUInt32LE(r.localCompressedSize ?? (wide ? 0xffffffff : r.descriptor ? 0 : compressed), 18);
    local.writeUInt32LE(r.localSize ?? (wide ? 0xffffffff : r.descriptor ? 0 : declared), 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(lx.length, 28);
    let descriptor = Buffer.alloc(0);
    if (r.descriptor) {
      const signed = r.signedDescriptor !== false;
      descriptor = Buffer.alloc((wide ? 20 : 12) + (signed ? 4 : 0));
      let at = 0;
      if (signed) { descriptor.writeUInt32LE(0x08074b50); at = 4; }
      descriptor.writeUInt32LE(r.descriptorCrc ?? crc, at);
      if (wide) {
        descriptor.writeBigUInt64LE(BigInt(compressed), at + 4);
        descriptor.writeBigUInt64LE(BigInt(r.descriptorSize ?? declared), at + 12);
      } else {
        descriptor.writeUInt32LE(compressed, at + 4);
        descriptor.writeUInt32LE(r.descriptorSize ?? declared, at + 8);
      }
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(r.madeBy ?? 0x031e, 4);
    c.writeUInt16LE(wide ? 45 : 20, 6); c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(wide ? 0xffffffff : compressed, 20);
    c.writeUInt32LE(wide ? 0xffffffff : declared, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(cx.length, 30);
    c.writeUInt32LE((r.attrs ?? (((r.mode ?? (r.name.endsWith('/') ? directory : regular)) << 16) | (r.name.endsWith('/') ? 0x10 : 0))) >>> 0, 38);
    c.writeUInt32LE(r.offset ?? offset, 42);
    const block = Buffer.concat([local, localName, lx, packed, descriptor]);
    locals.push(block); central.push(Buffer.concat([c, name, cx])); offset += block.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const file = (path, data = 'payload', options = {}) => ({ name: R + '/' + path, data, ...options });
const link = (path, target) => file(path, target, { mode: symlink });
const basic = () => [
  file('Contents/Info.plist', '<plist/>'),
  file('Contents/MacOS/faravan', 'synthetic executable', { mode: 0o100755 }),
  file('Contents/Resources/faravan/runtime/bin/node', 'synthetic runtime', { method: 8 }),
];
async function refuses(recordsOrBuffer, options = {}, code) {
  let extractorCalls = 0;
  const invoke = async () => {
    const result = await validateMacAppZip(Buffer.isBuffer(recordsOrBuffer) ? recordsOrBuffer : zip(recordsOrBuffer), options);
    extractorCalls++; // Only a fake callback. No native extraction occurred.
    return result;
  };
  await assert.rejects(invoke, e => {
    assert.ok(e instanceof MacAppZipError);
    assert.ok(MAC_ZIP_REASONS.includes(e.code));
    assert.equal(e.message, e.code);
    if (code) assert.equal(e.code, code);
    return true;
  });
  assert.equal(extractorCalls, 0);
}

test('complete synthetic app, AppleDouble metadata and framework link chain', async () => {
  const records = [
    { name: R + '/' },
    ...basic(),
    file('Contents/Frameworks/F.framework/Versions/A/F', 'framework', { method: 8 }),
    link('Contents/Frameworks/F.framework/Versions/Current', 'A'),
    link('Contents/Frameworks/F.framework/F', 'Versions/Current/F'),
    { name: '__MACOSX/' },
    { name: '__MACOSX/' + R + '/' },
    { name: '__MACOSX/._' + R, data: 'synthetic root metadata' },
    { name: '__MACOSX/' + R + '/Contents/._Info.plist', data: 'synthetic metadata' },
  ];
  let calls = 0;
  const result = await validateMacAppZip(zip(records));
  calls++;
  assert.equal(calls, 1);
  assert.equal(result.root, R);
  assert.equal(result.entries.length, records.length);
  assert.deepEqual(result.entries.find(e => e.name.endsWith('/Versions/Current')), {
    name: R + '/Contents/Frameworks/F.framework/Versions/Current',
    type: 'symlink', uncompressedSize: 1, target: 'A',
  });
});
test('implicit directories and DOS or untyped modes preserve names', async () => {
  const records = [
    { name: R + '/', madeBy: 20, attrs: 0x10 },
    file('Contents/a', 'a', { madeBy: 20, attrs: 0 }),
    file('Contents/b', 'b', { mode: 0o644 }),
    file('Contents/caf\u00e9', 'c'),
  ];
  assert.deepEqual((await validateMacAppZip(zip(records))).entries.map(e => e.name), records.map(r => r.name));
});
test('alternate caller-selected app identity stays exact', async () => {
  const records = [{ name: 'Faravan Preview.app/Contents/Info.plist', data: 'x' }];
  assert.equal((await validateMacAppZip(zip(records), { appName: 'Faravan Preview.app' })).root, 'Faravan Preview.app');
  await refuses(records, {}, 'ROOT');
});
for (const wide of [false, true]) for (const descriptor of [false, true]) {
  for (const signed of descriptor ? [false, true] : [true]) {
    test('stored/deflated entries with ZIP64=' + wide + ' descriptor=' + descriptor + ' signed=' + signed, async () => {
      const records = [0, 8].map(method => file('Contents/file' + method, 'hello '.repeat(20), {
        method, zip64: wide, descriptor, signedDescriptor: signed,
      }));
      assert.equal((await validateMacAppZip(zip(records))).entries.length, 2);
    });
  }
}
test('matching Unicode path extras work without losing original effective identity', async () => {
  const name = R + '/Contents/cafe', effective = R + '/Contents/caf\u00e9';
  const extra = unicodeName(Buffer.from(name), effective);
  const result = await validateMacAppZip(zip([{ name, extra, data: 'x' }]));
  assert.equal(result.entries[0].name, effective);
});

for (const name of ['/Faravan.app/x', 'C:/Faravan.app/x', 'C:Faravan.app/x',
  R + '\\Contents\\x', R + '/Contents/\0x', R + '/Contents/../x',
  R + '//x', R + '/./x', R + '/Contents/x//']) {
  test('unsafe archive name refused: ' + JSON.stringify(name), () => refuses([{ name, data: 'x' }]));
}
test('empty archive and second or wrong roots refused', async () => {
  await refuses([], {}, 'ROOT');
  await refuses([{ name: 'Other.app/a', data: 'x' }], {}, 'ROOT');
  await refuses([...basic(), { name: 'Other.app/a', data: 'x' }], {}, 'ROOT');
});
for (const [a, b] of [
  ['Contents/a', 'Contents/a'],
  ['Contents/a', 'Contents/A'],
  ['Contents/caf\u00e9', 'Contents/cafe\u0301'],
  ['Contents/stra\u00dfe', 'Contents/STRASSE'],
  ['Contents/Dir/a', 'Contents/dir/b'],
]) {
  test('explicit or implicit normalized collision: ' + a + ' / ' + b, () => refuses([file(a), file(b)], {}, 'COLLISION'));
}
test('file/directory and implicit-directory contradictions refused in either order', async () => {
  await refuses([file('Contents/a'), file('Contents/a/b')]);
  await refuses([file('Contents/a/b'), file('Contents/a')]);
  await refuses([{ name: R + '/' }, { name: R + '/' }], {}, 'COLLISION');
});
test('local name, effective Unicode, flags, method, sizes and CRC disagreement refused', async () => {
  for (const change of [
    { localName: R + '/Contents/other' },
    { localFlags: 0 },
    { localMethod: 8 },
    { localSize: 99 },
    { localCompressedSize: 99 },
    { localCrc: 123 },
    { localExtra: unicodeName(Buffer.from(R + '/Contents/x'), R + '/Contents/other') },
  ]) await refuses([file('Contents/x', 'x', change)], {}, 'HEADER');
  await refuses([file('Contents/x', 'x', { localName: '../escape' })]);
});
test('Unicode extras cannot disguise traversal in raw names', async () => {
  const name = '../escape', extra = unicodeName(Buffer.from(name), R + '/Contents/x');
  await refuses([{ name, extra, data: 'x' }], {}, 'PATH');
});
test('descriptor disagreement, ZIP64 missing size and malformed extras refused', async () => {
  await refuses([file('Contents/x', 'x', { method: 8, descriptor: true, descriptorSize: 99 })], {}, 'HEADER');
  await refuses([file('Contents/x', 'x', { descriptor: true, descriptorCrc: 123 })], {}, 'HEADER');
  await refuses([file('Contents/x', 'x', { localSize: 0xffffffff, localExtra: Buffer.alloc(0) })], {}, 'HEADER');
  await refuses([file('Contents/x', 'x', { localExtra: Buffer.from([1, 0, 8, 0, 1]) })]);
});
test('overlapping or reused local headers refused', async () => {
  await refuses([file('Contents/a', 'x'), file('Contents/b', 'y', { offset: 0 })]);
});
test('links escape, dangle or loop, including transitive chains', async () => {
  await refuses([link('Contents/l', '../../outside')], {}, 'LINK_ESCAPE');
  await refuses([link('Contents/l', 'missing')], {}, 'LINK_DANGLING');
  await refuses([link('Contents/a', 'b'), link('Contents/b', 'a')], {}, 'LINK_CYCLE');
  await refuses([link('Contents/a', 'a')], {}, 'LINK_CYCLE');
  await refuses([link('Contents/a', 'b'), link('Contents/b', '../../outside')], {}, 'LINK_ESCAPE');
  await refuses([link('Contents/a', 'b'), link('Contents/b', 'missing')], {}, 'LINK_DANGLING');
  for (const target of ['/tmp/x', 'C:/x', '..\\x', 'x\0y', '']) {
    await refuses([link('Contents/l', target)], {}, 'LINK_TARGET');
  }
  await refuses([file('Contents/l', Buffer.from([0xff]), { mode: symlink })], {}, 'LINK_TARGET');
});
test('root cannot be a link and writes below link parents are refused in either order', async () => {
  await refuses([{ name: R, mode: symlink, data: '.' }], {}, 'ROOT');
  for (const records of [
    [file('Contents/real/x'), link('Contents/l', 'real'), file('Contents/l/x')],
    [file('Contents/l/x'), link('Contents/l', 'real'), file('Contents/real/x')],
  ]) await refuses(records);
});
test('link dotdot follows resolved path, never lexical simplification', async () => {
  const records = [file('Contents/A/B/value'), file('Contents/A/other'),
    link('Contents/dir', 'A/B'), link('Contents/result', 'dir/../other')];
  assert.equal((await validateMacAppZip(zip(records))).entries.length, 4);
  await refuses([file('Contents/value'), link('Contents/l', 'value/../value')], {}, 'LINK_DANGLING');
  await refuses([file('Contents/value'), link('Contents/l', 'value/')], {}, 'LINK_DANGLING');
});
test('metadata only for corresponding app paths, never links or unrelated regular files', async () => {
  for (const r of [
    { name: '__MACOSX/Other.app/._x', data: 'x' },
    { name: '__MACOSX/' + R + '/Contents/x', data: 'x' },
    { name: '__MACOSX/' + R + '/Contents/._missing', data: 'x' },
    { name: '__MACOSX/' + R + '/Contents/._Info.plist', mode: symlink, data: 'x' },
    { name: '__MACOSX/Other.app/' },
  ]) await refuses([...basic(), r], {}, 'METADATA');
});
test('setuid/setgid and devices, sockets, FIFOs and DOS labels refused', async () => {
  for (const mode of [0o104755, 0o102755, 0o020600, 0o060600, 0o010600, 0o140600]) {
    await refuses([file('Contents/x', 'x', { mode })], {}, (mode & 0o6000) ? 'PRIVILEGE' : 'TYPE');
  }
  await refuses([file('Contents/x', 'x', { attrs: 8 })], {}, 'TYPE');
  await refuses([file('Contents/x', '', { mode: directory })], {}, 'TYPE');
  await refuses([file('Contents/x/', '', { mode: regular })], {}, 'TYPE');
});
test('encryption, unsupported compression and reserved flags refused', async () => {
  for (const flags of [1, 0x40, 0x2000]) await refuses([file('Contents/x', 'x', { flags })]);
  await refuses([file('Contents/x', 'x', { method: 12 })], {}, 'METHOD');
  await refuses([file('Contents/x', 'x', { flags: 0x10 })], {}, 'FORMAT');
});
test('malformed/truncated headers refuse without calling extractor', async () => {
  const good = zip(basic());
  for (const n of [0, 1, 20, 50, good.length - 1, good.length - 10]) await refuses(good.subarray(0, n));
  const bad = Buffer.from(good); bad.writeUInt32LE(0, 0); await refuses(bad);
});
test('actual/declared size, nonempty directories and CRC mismatch refuse', async () => {
  for (const method of [0, 8]) {
    await refuses([file('Contents/x', 'abcdef', { method, size: 1 })]);
    await refuses([file('Contents/x', 'abcdef', { method, size: 99 })]);
    await refuses([file('Contents/x', 'abcdef', { method, crc: 123 })], {}, 'CRC');
  }
  await refuses([{ name: R + '/Contents/', data: 'not empty' }], {}, 'SIZE');
});
test('entry, cumulative expanded and link limits include exact boundaries', async () => {
  await refuses([file('Contents/a'), file('Contents/b')], { maxEntries: 1 }, 'ENTRY_LIMIT');
  const records = [file('Contents/a', 'abc', { method: 8 }), file('Contents/b', 'def', { method: 8 })];
  assert.equal((await validateMacAppZip(zip(records), { maxEntries: 2, maxUncompressedBytes: 6 })).entries.length, 2);
  await refuses(records, { maxUncompressedBytes: 5 }, 'BYTE_LIMIT');
  const links = [file('Contents/a', ''), link('Contents/l', 'a')];
  assert.equal((await validateMacAppZip(zip(links), { maxSymlinkBytes: 1 })).entries.length, 2);
  await refuses([file('Contents/aa', ''), link('Contents/l', 'aa')], { maxSymlinkBytes: 1 }, 'LINK_LIMIT');
  await refuses([file('Contents/l', 'a'.repeat(10000), { mode: symlink, method: 8 })],
    { maxSymlinkBytes: 8 }, 'LINK_LIMIT');
});
test('compressed bomb fails early and closes stream/reader', { concurrency: false }, async () => {
  const original = yauzl.fromBufferPromise;
  let bytesExposed = 0, destroyed = 0, closed = 0, opened = 0;
  yauzl.fromBufferPromise = async (...args) => {
    const reader = await original(...args), open = reader.openReadStreamPromise.bind(reader);
    const close = reader.close.bind(reader);
    reader.close = () => { closed++; return close(); };
    reader.openReadStreamPromise = async (...streamArgs) => {
      const stream = await open(...streamArgs); opened++;
      const iterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = function () {
        const inner = iterator();
        return {
          async next() { const v = await inner.next(); if (!v.done) bytesExposed += v.value.length; return v; },
          return: (...a) => inner.return(...a),
          throw: (...a) => inner.throw(...a),
          [Symbol.asyncIterator]() { return this; },
        };
      };
      const destroy = stream.destroy.bind(stream);
      stream.destroy = (...a) => { destroyed++; return destroy(...a); };
      return stream;
    };
    return reader;
  };
  try {
    const huge = 'z'.repeat(2 * 1024 * 1024);
    await refuses([file('Contents/x', huge, { method: 8, size: 64 })], { maxUncompressedBytes: 64 });
    assert.equal(opened, 1);
    assert.ok(bytesExposed <= 64, 'yauzl size guard and consumer never expose the full inflate');
    assert.ok(destroyed > 0); assert.ok(closed > 0);
  } finally { yauzl.fromBufferPromise = original; }
});
test('reader closes for a policy failure before stream creation', { concurrency: false }, async () => {
  const original = yauzl.fromBufferPromise; let closed = 0;
  yauzl.fromBufferPromise = async (...args) => {
    const reader = await original(...args), close = reader.close.bind(reader);
    reader.close = () => { closed++; return close(); };
    return reader;
  };
  try { await refuses([{ name: 'Other.app/x', data: 'x' }]); assert.ok(closed > 0); }
  finally { yauzl.fromBufferPromise = original; }
});
test('bad limits and app names return bounded option errors', async () => {
  for (const options of [
    { maxEntries: 0 }, { maxEntries: Infinity }, { maxUncompressedBytes: -1 },
    { maxSymlinkBytes: 0 }, { appName: '../Faravan.app' }, { appName: 'not-app' },
  ]) await refuses(basic(), options, 'OPTIONS');
});

test('fixed namespace limits and non-object options fail closed', async () => {
  await refuses([file('Contents/' + 'a'.repeat(4096))], {}, 'PATH');
  await refuses([file('Contents/' + 'd/'.repeat(256) + 'x')], {}, 'PATH');
  await refuses(basic(), null, 'OPTIONS');
  await refuses(basic(), [], 'OPTIONS');
});
test('malformed UTF-8 raw names and Unicode overrides refuse', async () => {
  const buf = zip([file('Contents/x')]);
  // Change the same one-byte character in both redundant names, preserving lengths.
  const raw = Buffer.from(R + '/Contents/x');
  const first = buf.indexOf(raw), second = buf.indexOf(raw, first + raw.length);
  assert.ok(first >= 0 && second >= 0);
  buf[first + raw.length - 1] = 0xff; buf[second + raw.length - 1] = 0xff;
  await refuses(buf, {}, 'FORMAT');
  const invalid = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from([0xff])]);
  invalid.writeUInt32LE(crc32(raw), 1);
  await refuses([file('Contents/x', 'x', { extra: field(0x7075, invalid) })], {}, 'FORMAT');
});

test('descriptor zeros may accompany central ZIP64 sizes without local sentinels', async () => {
  const record = file('Contents/x', 'hello', {
    method: 8, zip64: true, descriptor: true,
    localSize: 0, localCompressedSize: 0, localExtra: Buffer.alloc(0),
  });
  assert.equal((await validateMacAppZip(zip([record]))).entries.length, 1);
});
