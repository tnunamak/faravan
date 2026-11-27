// A page owns only a small working set of decoded output images. A lease reserves
// one preview slot and its bytes until the caller releases the object URL.
export const OUTPUT_PREVIEW_LIMITS = Object.freeze({
  bytes: 24 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  count: 8,
  concurrency: 3,
  pixels: 16 * 1024 * 1024,
});

export function createOutputPreviewBudget(overrides = {}) {
  const limits = {...OUTPUT_PREVIEW_LIMITS,...overrides};
  let active = 0;
  let retainedCount = 0;
  let retainedBytes = 0;
  let inFlightBytes = 0;
  const waiting = [];

  function pump() {
    while (active < limits.concurrency && retainedCount < limits.count && retainedBytes + inFlightBytes + limits.maxImageBytes <= limits.bytes && waiting.length) {
      const task = waiting.shift();
      if (task.signal?.aborted) { task.resolve(null); continue; }
      task.signal?.removeEventListener('abort',task.cancel);
      active++;
      retainedCount++;
      inFlightBytes += limits.maxImageBytes;
      Promise.resolve().then(task.load).then(blob => {
        inFlightBytes -= limits.maxImageBytes;
        if (!blob || task.signal?.aborted || blob.size > limits.maxImageBytes || retainedBytes + inFlightBytes + blob.size > limits.bytes) {
          retainedCount--;
          active--;
          task.resolve(null);
          pump();
          return;
        }
        retainedBytes += blob.size;
        let released = false;
        active--;
        task.resolve({blob, release() {
          if (released) return;
          released = true;
          retainedCount--;
          retainedBytes -= blob.size;
          pump();
        }});
        pump();
      }, () => {
        inFlightBytes -= limits.maxImageBytes;
        retainedCount--;
        active--;
        task.resolve(null);
        pump();
      });
    }
  }

  return {
    acquire(load, {signal} = {}) {
      return new Promise(resolve => {
        if (signal?.aborted) { resolve(null); return; }
        const task = {load, signal, resolve};
        task.cancel = () => {
          const index = waiting.indexOf(task);
          if (index >= 0) { waiting.splice(index, 1); resolve(null); }
        };
        signal?.addEventListener('abort', task.cancel, {once:true});
        waiting.push(task);
        pump();
      });
    },
    snapshot() { return {active, retainedCount, retainedBytes, inFlightBytes, waiting:waiting.length}; },
  };
}

export const outputPreviewBudget = createOutputPreviewBudget();

function dimensions(bytes, mime) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && String.fromCharCode(...bytes.subarray(12,16)) === 'IHDR') return [view.getUint32(16),view.getUint32(20)];
  if (mime === 'image/gif' && bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return [view.getUint16(6,true),view.getUint16(8,true)];
  if (mime === 'image/webp' && bytes.length >= 30 && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP') {
    if (String.fromCharCode(...bytes.subarray(12,16)) === 'VP8X') return [1 + bytes[24] + (bytes[25]<<8) + (bytes[26]<<16),1 + bytes[27] + (bytes[28]<<8) + (bytes[29]<<16)];
    if (String.fromCharCode(...bytes.subarray(12,16)) === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return [view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff];
    if (String.fromCharCode(...bytes.subarray(12,16)) === 'VP8L' && bytes[20] === 0x2f) return [1 + ((bytes[22]&0x3f)<<8) + (bytes[21]),1 + ((bytes[24]&0x0f)<<10) + (bytes[23]<<2) + ((bytes[22]&0xc0)>>6)];
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i=2;i+9<bytes.length;) {
      if (bytes[i++] !== 0xff) continue;
      while (bytes[i] === 0xff) i++;
      const marker=bytes[i++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length=view.getUint16(i); if (length < 2 || i+length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return [view.getUint16(i+5),view.getUint16(i+3)];
      i += length;
    }
  }
  // SVG filter and vector allocations cannot be bounded by declared width/height.
  // Offer the download instead of decoding it in this page.

  return null;
}

export async function imageWithinPixelLimit(blob, maxPixels = OUTPUT_PREVIEW_LIMITS.pixels) {
  try {
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const size=dimensions(bytes,blob.type);
    if (!size || !Number.isSafeInteger(size[0]*size[1]) || size[0] <= 0 || size[1] <= 0 || size[0]*size[1] > maxPixels) return false;
    return true;
  } catch {
    return false;
  }
}

export async function readPreviewBlob(response,maxBytes=OUTPUT_PREVIEW_LIMITS.maxImageBytes) {
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks=[];let total=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){await reader.cancel();return null;}
      chunks.push(value);
    }
    return new Blob(chunks,{type:response.headers.get('content-type')?.split(';')[0] || ''});
  }finally{reader.releaseLock();}
}
