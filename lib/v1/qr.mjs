// A minimal QR Code encoder for the phone pairing link: byte mode, error correction level M, versions 1-10
// (up to 213 bytes). Follows ISO/IEC 18004 as laid out in Project Nayuki's reference implementation.
// Checked against an independent decoder in tests/v1-qr.test.mjs fixtures.

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0;
const MAX_VERSION = 10;

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = version => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function penalty(modules) {
  const size = modules.length;
  let score = 0, dark = 0;
  const lines = [];
  for (let i = 0; i < size; i++) lines.push(modules[i], modules.map(row => row[i]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += run - 2;
      run = 1;
    }
    const bits = line.map(Number).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = bits.indexOf(pattern); at !== -1; at = bits.indexOf(pattern, at + 1)) score += 40;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && modules[y][x] === modules[y][x + 1] &&
        modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The module matrix (true = dark) for text, or throws {code:'qr_too_long'}. `mask` forces a mask for tests. */
export function encodeQr(text, {mask} = {}) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let version = 1;
  const capacityBits = v => dataCodewords(v) * 8;
  const neededBits = v => 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
  while (version <= MAX_VERSION && neededBits(version) > capacityBits(version)) version++;
  if (version > MAX_VERSION) throw Object.assign(new Error('qr_too_long'), {code: 'qr_too_long'});

  const bits = [];
  const append = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = capacityBits(version);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  const blockCount = BLOCKS_M[version], eccLength = ECC_PER_BLOCK_M[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - raw % blockCount, shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(eccLength), blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(block[i]); });
  }

  const size = version * 4 + 17;
  const modules = Array.from({length: size}, () => new Array(size).fill(false));
  const fixed = Array.from({length: size}, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
    }
  }
  const aligned = alignmentPositions(version, size), last = aligned.length - 1;
  aligned.forEach((ay, i) => aligned.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = chosen => {
    const value = FORMAT_BITS_M << 3 | chosen;
    let remainder = value;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const format = (value << 10 | remainder) ^ 0x5412, bit = i => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const value = version << 12 | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((value >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vertical : vertical;
        if (!fixed[y][x] && index < codewords.length * 8) {
          modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
      }
    }
  }
  const masked = chosen => {
    const copy = modules.map(row => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[chosen](x, y)) copy[y][x] = !copy[y][x];
    return copy;
  };
  let best = mask;
  if (best === undefined) {
    let lowest = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      drawFormat(candidate);
      const score = penalty(masked(candidate));
      if (score < lowest) { lowest = score; best = candidate; }
    }
  }
  drawFormat(best);
  return masked(best);
}

/** One SVG path for the dark modules, offset by a 4-module quiet zone; `size` includes the zone. UIs draw it as data, never as HTML. */
export function qrPath(text) {
  const modules = encodeQr(text);
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z'; }));
  return {size: modules.length + 8, d};
}

/** A crisp, self-contained SVG. Dark on white in both themes: phone cameras need contrast. */
export function qrSvg(text) {
  const {size, d: path} = qrPath(text);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path fill="#000" d="' + path + '"/></svg>';
}
