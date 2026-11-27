export function pngOf(width,height) {
  const b=Buffer.alloc(33+12); Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
  b.writeUInt32BE(13,8); b.write('IHDR',12,'latin1'); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); b[24]=8; b[25]=6;
  b.write('IEND',37,'latin1'); return b;
}
export function jpegOf(width,height) {
  return Buffer.from([255,216,255,0xe0,0,4,0,0, 255,0xc0,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0, 255,0xd9]);
}
export function gifOf(width,height,frames=1) {
  const head=Buffer.alloc(13); head.write('GIF89a',0,'latin1'); head.writeUInt16LE(width,6); head.writeUInt16LE(height,8);
  const frame=Buffer.concat([Buffer.from([0x2c,0,0,0,0,width&255,width>>8,height&255,height>>8,0,2,1,0,0])]);
  return Buffer.concat([head,...Array(frames).fill(frame),Buffer.from([0x3b])]);
}
function chunk(type,body) { const h=Buffer.alloc(8); h.write(type,0,'latin1'); h.writeUInt32LE(body.length,4); return Buffer.concat([h,body,Buffer.alloc(body.length&1)]); }
function riff(...chunks) { const body=Buffer.concat([Buffer.from('WEBP'),...chunks]); const h=Buffer.alloc(8); h.write('RIFF',0,'latin1'); h.writeUInt32LE(body.length,4); return Buffer.concat([h,body]); }
export function webpLossless(width,height) { const body=Buffer.alloc(5); body[0]=0x2f; body.writeUInt32LE((width-1)|((height-1)<<14),1); return riff(chunk('VP8L',body)); }
export function webpLossy(width,height) { const body=Buffer.alloc(10); body.writeUIntBE(0x9d012a,3,3); body.writeUInt16LE(width,6); body.writeUInt16LE(height,8); return riff(chunk('VP8 ',body)); }
export function webpAnimated(width,height,frames) {
  const vp8x=Buffer.alloc(10); vp8x[0]=2; vp8x.writeUIntLE(width-1,4,3); vp8x.writeUIntLE(height-1,7,3);
  return riff(chunk('VP8X',vp8x),...Array(frames).fill(0).map(()=>chunk('ANMF',Buffer.alloc(16))));
}
