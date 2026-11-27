/** Fail-closed raster preview gate: read dimensions from headers only, never decode pixels. */
export const RASTER_MAX_EDGE = 4096;
export const RASTER_MAX_PIXELS = 4_000_000;
export const RASTER_MAX_BYTES = 10 * 1024 * 1024;
export const RASTER_MAX_FRAMES = 100;
// Animated images decode every frame, so the whole animation shares one bounded budget.
const RASTER_MAX_ANIMATION_PIXELS = RASTER_MAX_PIXELS;
const TYPES = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};

function png(b) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  if (b.length < 33 || !b.subarray(0,8).equals(sig) || b.readUInt32BE(8) !== 13 || b.toString('latin1',12,16) !== 'IHDR') return null;
  // APNG frame canvases need a separate animation budget; keep those download-only.
  for(let i=33;i+12<=b.length;){
    const size=b.readUInt32BE(i),type=b.toString('latin1',i+4,i+8);
    if(i+12+size>b.length||type==='acTL'||type==='IHDR')return null;
    i+=12+size;if(type==='IEND')return {width:b.readUInt32BE(16),height:b.readUInt32BE(20),frames:1};
  }
  return null;
}
function jpeg(b) {
  let info=null;
  if (b[0] !== 255 || b[1] !== 216 || b[2] !== 255) return null;
  for (let i = 2; i + 2 <= b.length;) {
    if (b[i] !== 255) return null;
    const marker = b[i+1];
    if (marker === 255) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return info;
    if(i+4>b.length)return null;
    const length = b.readUInt16BE(i+2);
    if (length < 2 || i+2+length>b.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
      if (length < 8 || i + 9 > b.length) return null;
      const frame={height:b.readUInt16BE(i+5),width:b.readUInt16BE(i+7),frames:1};
      if(info&&(info.width!==frame.width||info.height!==frame.height))return null;
      info=frame;
    }
    i += 2 + length;
  }
  return null;
}
function gif(b) {
  if (b.length < 13 || !/^GIF8[79]a/.test(b.toString('latin1',0,6))) return null;
  const width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  let i = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0), frames = 0;
  const skipBlocks = () => { while (i < b.length && b[i]) i += b[i] + 1; i++; };
  while (i < b.length) {
    const tag = b[i++];
    if (tag === 0x3b) return {width,height,frames:Math.max(frames,1)};
    if (tag === 0x21) { i++; skipBlocks(); }
    else if (tag === 0x2c) {
      if (++frames > RASTER_MAX_FRAMES || i + 9 > b.length) return null;
      const frameWidth=b.readUInt16LE(i+4),frameHeight=b.readUInt16LE(i+6);
      if(!frameWidth||!frameHeight||b.readUInt16LE(i)+frameWidth>width||b.readUInt16LE(i+2)+frameHeight>height)return null;
      const flags = b[i+8]; i += 9;
      if (flags & 0x80) i += 3 * 2 ** ((flags & 7) + 1);
      i++; skipBlocks();
    } else return null;
  }
  return null;
}
function webp(b) {
  if (b.length < 20 || b.toString('latin1',0,4) !== 'RIFF' || b.toString('latin1',8,12) !== 'WEBP') return null;
  let result = null;
  for (let i = 12; i + 8 <= b.length;) {
    const type = b.toString('latin1',i,i+4), size = b.readUInt32LE(i+4), body = i + 8;
    if (body + size > b.length) return null;
    if (type === 'VP8X') {
      if (result || size < 10) return null;
      if(b[body]&2)return null; // animated WebP is download-only
      result = {width:1 + b.readUIntLE(body+4,3),height:1 + b.readUIntLE(body+7,3)};
    } else if (type === 'ANMF') return null;
    else if (type === 'VP8 ') {
      if (size < 10 || b.readUIntBE(body+3,3) !== 0x9d012a) return null;
      const frame={width:b.readUInt16LE(body+6)&0x3fff,height:b.readUInt16LE(body+8)&0x3fff};
      if(result&&(result.width!==frame.width||result.height!==frame.height))return null;
      result=frame;
    } else if (type === 'VP8L') {
      if (size < 5 || b[body] !== 0x2f) return null;
      const bits = b.readUInt32LE(body+1);
      const frame={width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};
      if(result&&(result.width!==frame.width||result.height!==frame.height))return null;
      result=frame;
    }
    i = body + size + (size & 1);
  }
  if (!result) return null;
  return {...result,frames:1};
}

/** Returns {media_type,width,height} only for supported raster headers within every budget; otherwise null. */
export function rasterPreview(path, bytes) {
  const media_type = TYPES[String(path).split('.').at(-1)?.toLowerCase()];
  if (!media_type || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length >= RASTER_MAX_BYTES) return null;
  let info;
  try { info = {'image/png':png,'image/jpeg':jpeg,'image/gif':gif,'image/webp':webp}[media_type](bytes); } catch { return null; }
  if (!info) return null;
  const {width,height,frames} = info;
  if (!(width > 0 && height > 0 && frames > 0 && frames <= RASTER_MAX_FRAMES)) return null;
  if (width > RASTER_MAX_EDGE || height > RASTER_MAX_EDGE || width * height > RASTER_MAX_PIXELS) return null;
  if (width * height * frames > RASTER_MAX_ANIMATION_PIXELS) return null;
  return {media_type,width,height};
}
