import {mount, resetPage, teardown, click, forceClick, flush} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {ApplySheet} from './apply-sheet.jsx';

// The Add as a branch write is sent once. Closing the sheet, or unmounting and reopening it, while the first
// write has no known outcome must not allow a second write. The lock lives with the API object, not the sheet.
beforeEach(()=>resetPage('#/job/x'));
afterEach(teardown);
const digest='sha256:'+'3f'.repeat(32);
const repo='/home/ana/code/booking-site';
const preview={job_digest:digest,status:'preview',branch:'faravan/3f3f3f3f3f3f',base:'a'.repeat(40),repo,head:'b'.repeat(40),current_branch:'main',preview_token:'signed-preview',patch_hash:'d'.repeat(64),
  files:1,files_changed:[{path:'src/form.tsx',insertions:3,deletions:1}]};
const applied={...preview,status:'applied',commit:'c'.repeat(40)};
function fakeApi() {
  const calls=[], writes=[];
  const api={calls,writes,
    post(path,body){
      calls.push(body);
      if(body.dry_run)return Promise.resolve(preview);
      return new Promise((resolve,reject)=>writes.push({body,resolve,reject}));
    }};
  return api;
}
const sheet=(api,over={})=>h(ApplySheet,{open:true,api,jobId:digest,circle:'weekend',lender:'Ana',sourceFolder:repo,sourceBranch:'',onClose(){},onApplied(){},...over});
const text=()=>document.body.textContent.replace(/\s+/g,' ');
const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label)??null;

test('closing and reopening the sheet during a pending write cannot start a second write',async()=>{
  const api=fakeApi(), delivered=[];
  const onApplied=out=>{delivered.push(out);};
  let view=await mount(sheet(api,{onApplied}));
  assert.equal(api.calls.filter(c=>c.dry_run).length,1,'opening previews once');
  await click(button('Add the branch'));
  assert.equal(api.writes.length,1,'the first write is sent');
  assert.match(text(),/Adding the branch/);
  assert.equal(button('Cancel').getAttribute('aria-disabled'),'true','Cancel is locked while the write is pending');

  // The parent closes the sheet (open=false): it stays up showing the pending write.
  await view.rerender(sheet(api,{open:false,onApplied}));
  assert.match(text(),/Adding the branch/);

  // The sheet is unmounted, then a new one is opened: same job, same API.
  await view.unmount();
  view=await mount(sheet(api,{onApplied}));
  assert.match(text(),/Adding the branch/,'the reopened sheet still shows the pending write');
  assert.equal(api.calls.filter(c=>c.dry_run).length,1,'reopening does not preview again');
  for (const label of ['Add the branch','Check the repository','Cancel']) {
    const found=button(label);
    if(found){assert.equal(found.getAttribute('aria-disabled'),'true',label+' is disabled');await forceClick(found);}
  }
  assert.equal(api.writes.length,1,'no second write was sent');
  assert.equal(api.calls.filter(c=>!c.dry_run).length,1);
  assert.deepEqual(delivered,[]);

  // The first outcome arrives: it is shown once and the lock ends.
  api.writes[0].resolve(applied);
  await flush();
  assert.deepEqual(delivered.map(o=>o.status),['applied']);
  assert.equal(api.writes.length,1);
});

test('an unknown write outcome stays locked across reopen until the submitted branch is checked',async()=>{
  const api=fakeApi();
  let view=await mount(sheet(api));
  await click(button('Add the branch'));
  api.writes[0].reject(Object.assign(new Error('network'),{}));
  await flush();
  assert.match(text(),/Could not confirm whether/);
  await view.unmount();
  view=await mount(sheet(api));
  assert.match(text(),/Do not add it again/);
  for (const label of ['Add the branch','Check the repository']) {
    const found=button(label);
    if(found){assert.equal(found.getAttribute('aria-disabled'),'true',label+' is disabled');await forceClick(found);}
  }
  assert.equal(api.calls.filter(c=>!c.dry_run).length,1,'only the original write was sent');
  assert.ok(button('Check the submitted branch'),'the only way forward is the read-only check');
});

test('same-name foreign result stays locked until the preview identity is reconciled',async()=>{
  const api=fakeApi(), delivered=[];
  await mount(sheet(api,{onApplied:out=>delivered.push(out)}));
  await click(button('Add the branch'));
  api.writes[0].reject(new Error('connection lost'));
  await flush();
  const post=api.post;
  api.post=(path,body)=>body.dry_run
    ? Promise.resolve({...applied,job_digest:'sha256:'+'e'.repeat(64)})
    : post(path,body);
  await click(button('Check the submitted branch'));
  await flush();
  assert.deepEqual(delivered,[]);
  assert.match(text(),/Do not add it again/);
  assert.equal(api.writes.length,1);
  assert.equal(button('Cancel').getAttribute('aria-disabled'),'true');
  api.post=()=>Promise.resolve(applied);
  await click(button('Check the submitted branch'));
  await flush();
  assert.deepEqual(delivered,[applied]);
  assert.equal(api.writes.length,1);
});
