import test,{afterEach} from 'node:test';
import {h} from 'preact';
import {mount,flush,teardown} from './mounted.test-helper.mjs';
import assert from 'node:assert/strict';
import {createPreviewBudget,fetchPreviewBlob,MAX_ACTIVE_PREVIEWS,MAX_PREVIEW_BYTES,ImagePreview} from './image-preview.jsx';
import {renderFixture} from './render.test-helper.mjs';

test('the budget keeps at most two previews open and closes the oldest first',()=>{
  const closed=[], budget=createPreviewBudget();
  const a=()=>closed.push('a'), b=()=>closed.push('b'), c=()=>closed.push('c');
  assert.equal(MAX_ACTIVE_PREVIEWS,2);
  budget.open(a);budget.open(b);assert.deepEqual(closed,[]);
  budget.open(c);assert.deepEqual(closed,['a']);assert.equal(budget.size,2);
  budget.release(b);budget.release(c);assert.equal(budget.size,0);
  budget.release(a);assert.equal(budget.size,0);
});
test('an image is not fetched or rendered until the reader asks for it',()=>{
  let requests=0;
  const html=renderFixture(ImagePreview,{file:{path:'a.png',preview:{media_type:'image/png',url:'/api/jobs/x/image?path=a.png'}},api:{request(){requests++;}}});
  assert.equal(requests,0);
  assert.match(html,/Show image preview/);
  assert.doesNotMatch(html,/<img|blob:/);
});
test('the encoded fetch refuses a body at or above 10 MiB, advertised or actual',async()=>{
  const response=(size,length)=>({headers:{get:()=>length},blob:async()=>({size})});
  assert.equal((await fetchPreviewBlob({request:async()=>response(5,'5')},'/api/x')).size,5);
  await assert.rejects(fetchPreviewBlob({request:async()=>response(5,String(MAX_PREVIEW_BYTES))},'/api/x'),/too large/);
  await assert.rejects(fetchPreviewBlob({request:async()=>response(MAX_PREVIEW_BYTES,null)},'/api/x'),/too large/);
});

test('streamed image data is cancelled at the byte budget before constructing an oversized blob',async()=>{
 let cancelled=false,reads=0;
 const reader={read:async()=>{reads++;return {done:false,value:new Uint8Array(MAX_PREVIEW_BYTES/2)};},cancel:async()=>{cancelled=true;},releaseLock(){}};
 const api={request:async()=>({headers:{get:()=>null},body:{getReader:()=>reader}})};
 await assert.rejects(fetchPreviewBlob(api,'/api/x'),/too large/);assert.equal(cancelled,true);assert.equal(reads,2);
});

test('without an api the preview never decodes the public URL directly',()=>{
  const html=renderFixture(ImagePreview,{file:{path:'a.png',preview:{url:'/api/jobs/x/image?path=a.png'}}});
  assert.doesNotMatch(html,/<img/);
});

afterEach(teardown);
const previewFile={path:'a.png',preview:{url:'/api/jobs/x/image?path=a.png'}};
test('a shown preview without an API explains unavailability, not a page limit',async()=>{
 const view=await mount(h(ImagePreview,{file:previewFile,inline:true}));
 assert.match(view.$('figure').textContent,/This image cannot be previewed here/);
 assert.doesNotMatch(view.$('figure').textContent,/page’s limits|Loading image/);
});
test('opening a third preview explains eviction and reopening clears the note',async()=>{
 const view=await mount(h('div',{},[0,1,2].map(key=>h(ImagePreview,{key,file:previewFile,inline:true}))));
 await flush();
 assert.match(view.$('figure').textContent,/Closed to keep the page within its preview limit/);
 view.button('Show image preview').click();await flush();
 assert.doesNotMatch(view.$('figure').textContent,/Closed to keep/);
 assert.match(view.$('figure').textContent,/Hide image preview/);
});
test('a transient preview failure offers a retry that makes a fresh request',async()=>{
 let requests=0;
 const view=await mount(h(ImagePreview,{file:previewFile,api:{request:async()=>{requests++;throw new Error('offline');}}}));
 const original=globalThis.IntersectionObserver;
 globalThis.IntersectionObserver=class {constructor(callback){this.callback=callback;}observe(){this.callback([{isIntersecting:true}]);}disconnect(){}};
 try {
  view.button('Show image preview').click();await flush();await flush();
  assert.equal(requests,1);assert.ok(view.button('Try preview again'));
  view.button('Try preview again').click();await flush();await flush();
  assert.equal(requests,2);assert.ok(view.button('Try preview again'));
 } finally {globalThis.IntersectionObserver=original;}
});

test('a non-inline tiny image explains its dimensions instead of silently rendering',async()=>{
 const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64'));
 const api={request:async()=>({headers:{get:key=>key==='content-type'?'image/png':String(bytes.length)},blob:async()=>new Blob([bytes],{type:'image/png'})})};
 const view=await mount(h(ImagePreview,{file:previewFile,api}));
 const original=globalThis.IntersectionObserver,create=URL.createObjectURL,revoke=URL.revokeObjectURL,bitmap=globalThis.createImageBitmap;
 globalThis.IntersectionObserver=class {constructor(callback){this.callback=callback;}observe(){this.callback([{isIntersecting:true}]);}disconnect(){}};
 URL.createObjectURL=()=> 'blob:tiny-preview';URL.revokeObjectURL=()=>{};
 globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
 try {
  view.button('Show image preview').click();await flush();await flush();
  const img=view.$('img');assert.ok(img);
  Object.defineProperty(img,'naturalWidth',{value:1});Object.defineProperty(img,'naturalHeight',{value:1});
  img.dispatchEvent(new Event('load'));await flush();
  assert.match(view.$('figure').textContent,/1 × 1 pixels · too small to preview/);
  assert.equal(view.$('img'),null);
 } finally {globalThis.IntersectionObserver=original;URL.createObjectURL=create;URL.revokeObjectURL=revoke;globalThis.createImageBitmap=bitmap;}
});
