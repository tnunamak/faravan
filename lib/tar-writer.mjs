// Canonical tar output: file contents and executable bits, no source archive metadata.
const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';
function header(name, size, mode, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8'); h.write(octal(mode, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124); h.write(octal(0, 12), 136); h.fill(' ', 148, 156); h.write(type, 156);
  h.write('ustar\0', 257, 'latin1'); h.write('00', 263, 'latin1');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}
const padded = data => Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)]);
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(length + body);
}
export function createTar(entries) {
  const parts = [];
  for (const {name: path, data, mode, type} of entries) {
    let name = path;
    if (Buffer.byteLength(path) > 100) {
      const pax = paxRecord('path', path);
      parts.push(header('pax', pax.length, 0o644, 'x'), padded(pax));
      name = 'long-name';
    }
    parts.push(header(name, data.length, mode, type), padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
