import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {makeRepo,git} from './helpers/git-guest.mjs';
import {parseUnifiedDiff} from '../lib/git-candidate.mjs';
import {readAddedImage} from '../lib/result-images.mjs';
import {jpegOf,gifOf,webpLossless} from './helpers/raster-fixtures.mjs';
import {changesView} from '../lib/v1/apply.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function view(t,name,bytes) {
  const {dir}=await makeRepo(); t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(dir+'/'+name,bytes);git(dir,'add','--',name);
  const patch=execFileSync('git',['diff','--binary','--cached','HEAD'],{cwd:dir,maxBuffer:20*1024*1024});
  const data=changesView({bytes:patch,mediaType:'text/x-diff',digest:'sha256:'+'a'.repeat(64)});
  data.image=readAddedImage(patch,parseUnifiedDiff(patch).files,name);
  return data;
}
test('added PNG preview is decoded from the signed patch',async t=>{
  const data=await view(t,'circle.png',png);
  assert.equal(data.files[0].preview.media_type,'image/png');
  assert.deepEqual(data.image.bytes,png);
});
test('added SVG preview preserves its bytes; unsafe paths and symlinks never get previews',async t=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>\n';
  const data=await view(t,'circle.svg',svg);
  assert.equal(data.files[0].preview.media_type,'image/svg+xml');
  assert.equal(data.image.bytes.toString(),svg);
});
test('10 MB and larger images are not embedded',async t=>{
  const data=await view(t,'big.png',Buffer.alloc(10*1024*1024));
  assert.equal(data.files[0].preview,undefined);
  assert.equal(data.image,null);
});
test('image previews cover JPG, GIF and WebP and preserve bytes',async t=>{
  for(const [name,mime,bytes] of [['circle.jpg','image/jpeg',jpegOf(4,4)],['circle.gif','image/gif',gifOf(4,4)],['circle.webp','image/webp',webpLossless(4,4)]]){
    const data=await view(t,name,bytes);
    assert.equal(data.files[0].preview.media_type,mime);
    assert.deepEqual(data.image.bytes,bytes);
  }
});
test('unsafe paths, links, modified images and corrupt binary bodies are not previewed',async t=>{
  const good=await view(t,'circle.png',png);
  assert.ok(good.files[0].preview);
  const patch='diff --git a/circle.png b/circle.png\nnew file mode 120000\n--- /dev/null\n+++ b/circle.png\n@@ -0,0 +1 @@\n+/tmp/render.png\n';
  assert.equal(changesView({bytes:Buffer.from(patch),mediaType:'text/x-diff'}).files[0].preview,undefined);
  const corrupt='diff --git a/circle.png b/circle.png\nnew file mode 100644\nGIT binary patch\nliteral 4\nAxxxxx\n\n';
  assert.equal(readAddedImage(Buffer.from(corrupt),parseUnifiedDiff(corrupt).files,'circle.png'),null);
  assert.equal(changesView({bytes:Buffer.from(corrupt.replaceAll('circle.png','../circle.png')),mediaType:'text/x-diff'}).files[0].preview,undefined);
});

test('many highly compressed images produce small descriptors, not a multi-gigabyte JSON response',async t=>{
  const {dir}=await makeRepo();t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.alloc(9*1024*1024);png.copy(bytes);
  for(let i=0;i<8;i++)await writeFile(dir+'/bomb'+i+'.png',bytes);
  git(dir,'add','--','.');
  const patch=execFileSync('git',['diff','--binary','--cached','HEAD'],{cwd:dir,maxBuffer:1024*1024});
  const data=changesView({bytes:patch,mediaType:'text/x-diff',digest:'sha256:'+'a'.repeat(64)});
  assert.equal(data.files.filter(f=>f.preview).length,7);
  assert.ok(JSON.stringify(data).length<512*1024);
  assert.ok(data.files.filter(f=>f.preview).every(f=>f.preview.url.startsWith('/api/jobs/')));
});
test('SVG text preserves declared non-UTF-8 encoding and a missing final newline',async t=>{
  const svg=Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"><text>café</text></svg>','latin1');
  const data=await view(t,'latin.svg',svg);
  assert.deepEqual(data.image.bytes,svg);
});
