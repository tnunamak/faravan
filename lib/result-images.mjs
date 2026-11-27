/** Read added image bytes from a verified Git patch, without writing its files. */
import {inflateSync} from 'node:zlib';
import {unsafePatchPath} from './git-candidate.mjs';
import {rasterPreview} from './raster-preview.mjs';

export const IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;
const MIME = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml'};
const BASE85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

function literalBytes(block) {
  const match = /\nGIT binary patch\nliteral (\d+)\n([\s\S]*?)(?:\n\n|$)/.exec(block.toString('ascii'));
  if (!match || Number(match[1]) >= IMAGE_PREVIEW_LIMIT) return null;
  const chunks = [];
  for (const line of match[2].split('\n')) {
    const first = line.charCodeAt(0);
    const length = first >= 65 && first <= 90 ? first - 64 : first >= 97 && first <= 122 ? first - 70 : 0;
    if (!length || line.length !== 1 + Math.ceil(length / 4) * 5) return null;
    const decoded = Buffer.alloc(Math.ceil(length / 4) * 4);
    for (let i = 1, offset = 0; i < line.length; i += 5, offset += 4) {
      let value = 0;
      for (const ch of line.slice(i,i+5)) {
        const digit = BASE85.indexOf(ch);
        if (digit < 0) return null;
        value = value * 85 + digit;
      }
      if (value > 0xffffffff) return null;
      decoded.writeUInt32BE(value,offset);
    }
    chunks.push(decoded.subarray(0,length));
  }
  const bytes = inflateSync(Buffer.concat(chunks),{maxOutputLength:Number(match[1])});
  return bytes.length === Number(match[1]) ? bytes : null;
}
function textBytes(block) {
  const added = [];
  let inHunk = false, start = 0;
  while (start < block.length) {
    const newline = block.indexOf(10,start);
    const end = newline < 0 ? block.length : newline + 1;
    const line = block.subarray(start,end); start = end;
    if (line[0] === 64 && line[1] === 64) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line[0] === 43) added.push(line.subarray(1));
    else if (line[0] === 92 && added.length) added[added.length-1] = added.at(-1).subarray(0,added.at(-1).length-1);
  }
  return Buffer.concat(added);
}

function imageType(file) {
  const mime = MIME[file.path.split('.').at(-1)?.toLowerCase()];
  return mime && file.status === 'added' && ['100644','100755'].includes(file.newMode) && !unsafePatchPath(file.path) ? mime : null;
}
function imageBlocks(patch) {
  const source = Buffer.from(patch), blocks = [];
  let start = 0, next;
  while ((next = source.indexOf('\ndiff --git ',start)) >= 0) {
    blocks.push(source.subarray(start,next+1)); start = next+1;
  }
  if (start < source.length) blocks.push(source.subarray(start));
  return blocks;
}

function matchesType(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii'));
  if (mime === 'image/webp') return bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  return /<svg(?:\s|>)/i.test(bytes.toString('utf8'));
}

/** Header-only dimension check on the bytes the image route would serve; null means never preview. */
function decodedRaster(file, block) {
  try { return rasterPreview(file.path, file.binary ? literalBytes(block) : textBytes(block)); } catch { return null; }
}

/** Small descriptors only: never expand all compressed images into one JSON response. */
export function addedImagePreviews(patch, files, {digest, circle} = {}) {
  const blocks = imageBlocks(patch);
  let rasterScanBytes=64*1024*1024;
  return files.map((file,index) => {
    const media_type = imageType(file);
    if (!media_type) return undefined;
    const size = file.binary ? Number(/\nGIT binary patch\nliteral (\d+)\n/.exec(blocks[index].toString('ascii'))?.[1]) : textBytes(blocks[index]).length;
    if (!Number.isSafeInteger(size) || size <= 0 || size >= IMAGE_PREVIEW_LIMIT) return undefined;
    if (media_type !== 'image/svg+xml') {
      if(size>rasterScanBytes)return undefined;
      rasterScanBytes-=size;
      if(!decodedRaster(file,blocks[index]))return undefined;
    }
    const query = new URLSearchParams({...(circle ? {circle} : {}),path:file.path});
    return {media_type,url:'/api/jobs/' + encodeURIComponent(digest) + '/image?' + query};
  });
}

/** Decode just the requested image; each response is bounded below 10 MB. */
export function readAddedImage(patch, files, path) {
  const index = files.findIndex(file => file.path === path);
  const file = files[index], media_type = file && imageType(file);
  if (!media_type) return null;
  try {
    const block = imageBlocks(patch)[index];
    const bytes = file.binary ? literalBytes(block) : textBytes(block);
    if (!bytes?.length || bytes.length >= IMAGE_PREVIEW_LIMIT || !matchesType(bytes,media_type)) return null;
    if (media_type !== 'image/svg+xml' && !rasterPreview(path,bytes)) return null;
    return {media_type,bytes};
  } catch { return null; }
}
