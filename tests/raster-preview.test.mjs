import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {makeRepo,git} from './helpers/git-guest.mjs';
import {parseUnifiedDiff} from '../lib/git-candidate.mjs';
import {readAddedImage} from '../lib/result-images.mjs';
import {changesView} from '../lib/v1/apply.mjs';
import {pngOf,jpegOf,gifOf,webpLossless,webpLossy,webpAnimated} from './helpers/raster-fixtures.mjs';
import {rasterPreview,RASTER_MAX_EDGE,RASTER_MAX_PIXELS} from '../lib/raster-preview.mjs';

test('accepts small PNG, JPEG, GIF and WebP and reports their dimensions',()=>{
  assert.deepEqual(rasterPreview('a.png',pngOf(640,480)),{media_type:'image/png',width:640,height:480});
  assert.deepEqual(rasterPreview('a.JPG',jpegOf(300,200)),{media_type:'image/jpeg',width:300,height:200});
  assert.deepEqual(rasterPreview('a.gif',gifOf(10,20)),{media_type:'image/gif',width:10,height:20});
  assert.deepEqual(rasterPreview('a.webp',webpLossless(50,60)),{media_type:'image/webp',width:50,height:60});
  assert.deepEqual(rasterPreview('a.webp',webpLossy(70,80)),{media_type:'image/webp',width:70,height:80});
});
test('a 12000x12000 PNG (small on disk, ~576 MB decoded) is rejected',()=>{
  const bomb=pngOf(12000,12000);
  assert.ok(bomb.length<100);
  assert.equal(rasterPreview('bomb.png',bomb),null);
});
test('edge and pixel budgets are exact',()=>{
  assert.ok(rasterPreview('a.png',pngOf(RASTER_MAX_EDGE,RASTER_MAX_PIXELS/RASTER_MAX_EDGE|0)));
  assert.equal(rasterPreview('a.png',pngOf(RASTER_MAX_EDGE+1,10)),null);
  assert.equal(rasterPreview('a.png',pngOf(10,RASTER_MAX_EDGE+1)),null);
  assert.equal(rasterPreview('a.png',pngOf(2001,2000)),null);
  assert.ok(rasterPreview('a.png',pngOf(2000,2000)));
  assert.equal(rasterPreview('a.jpg',jpegOf(5000,100)),null);
  assert.equal(rasterPreview('a.gif',gifOf(3000,3000)),null);
  assert.equal(rasterPreview('a.webp',webpLossless(12000,12000)),null);
  assert.equal(rasterPreview('a.webp',webpLossy(9000,9000)),null);
});
test('animations that exceed the shared budget or frame cap are rejected',()=>{
  assert.ok(rasterPreview('a.gif',gifOf(100,100,50)));
  assert.equal(rasterPreview('a.gif',gifOf(100,100,101)),null);
  assert.equal(rasterPreview('a.gif',gifOf(2000,2000,30)),null);
  assert.equal(rasterPreview('a.webp',webpAnimated(2000,2000,30)),null);
  assert.equal(rasterPreview('a.webp',webpAnimated(100,100,5)),null,'animated WebP is download-only');
});
test('malformed, mismatched, empty, zero-size and unsupported images fail closed',()=>{
  assert.equal(rasterPreview('a.png',pngOf(0,10)),null);
  assert.equal(rasterPreview('a.png',pngOf(10,0)),null);
  assert.equal(rasterPreview('a.png',pngOf(10,10).subarray(0,20)),null);
  assert.equal(rasterPreview('a.png',jpegOf(10,10)),null);
  assert.equal(rasterPreview('a.jpg',Buffer.from([255,216,255,0])),null);
  assert.equal(rasterPreview('a.gif',Buffer.from('GIF89a')),null);
  assert.equal(rasterPreview('a.webp',Buffer.from('RIFF0000WEBP')),null);
  assert.equal(rasterPreview('a.webp',webpLossless(10,10).subarray(0,22)),null);
  assert.equal(rasterPreview('a.png',Buffer.alloc(0)),null);
  assert.equal(rasterPreview('a.bmp',pngOf(10,10)),null);
  assert.equal(rasterPreview('a.svg',Buffer.from('<svg></svg>')),null);
  assert.equal(rasterPreview('a.png','not a buffer'),null);
});
test('encoded size is capped at 10 MiB',()=>{
  const big=Buffer.concat([pngOf(10,10),Buffer.alloc(10*1024*1024)]);
  assert.equal(rasterPreview('a.png',big),null);
});

async function patchOf(t,files) {
  const {dir}=await makeRepo(); t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,bytes] of Object.entries(files)) await writeFile(dir+'/'+name,bytes);
  git(dir,'add','--','.');
  return execFileSync('git',['diff','--binary','--cached','HEAD'],{cwd:dir,maxBuffer:20*1024*1024});
}
test('an oversized-dimension PNG is neither advertised nor served; a sane one still is',async t=>{
  const patch=await patchOf(t,{'bomb.png':pngOf(12000,12000),'ok.png':pngOf(32,32)});
  const data=changesView({bytes:patch,mediaType:'text/x-diff',digest:'sha256:'+'a'.repeat(64)});
  const files=parseUnifiedDiff(patch).files;
  const by=Object.fromEntries(data.files.map(f=>[f.path,f]));
  assert.equal(by['bomb.png'].preview,undefined);
  assert.equal(readAddedImage(patch,files,'bomb.png'),null);
  assert.equal(by['ok.png'].preview.media_type,'image/png');
  assert.equal(readAddedImage(patch,files,'ok.png').media_type,'image/png');
});

test('animation control and oversized GIF local frames cannot bypass the canvas budget',()=>{
 const png=pngOf(32,32);const control=Buffer.alloc(20);control.writeUInt32BE(8,0);control.write('acTL',4);control.writeUInt32BE(10000,8);
 assert.equal(rasterPreview('animated.png',Buffer.concat([png.subarray(0,33),control,png.subarray(33)])),null);
 const gif=gifOf(1,1);gif.writeUInt16LE(12000,18);gif.writeUInt16LE(12000,20);
 assert.equal(rasterPreview('frame.gif',gif),null);
});

test('conflicting JPEG frames cannot replace bounded dimensions after the first frame header',()=>{
 const small=jpegOf(32,32),large=jpegOf(12000,12000);
 const conflict=Buffer.concat([small.subarray(0,small.length-2),large.subarray(8)]);
 assert.equal(rasterPreview('conflict.jpg',conflict),null);
});
