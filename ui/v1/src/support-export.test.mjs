import {mount, click, flush, forceClick, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {supportPreview} from '../../../lib/v1/diagnostics.mjs';
import {readArchiveFiles} from '../../../lib/archive.mjs';
import {SupportExport} from './support-export.jsx';
import {Settings} from './info.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';

afterEach(teardown);

async function snapshot() {
  const scratch = fileURLToPath(new URL('../../../test-artifacts/support-ui/', import.meta.url));
  await mkdir(scratch, {recursive:true});
  const root = await mkdtemp(join(scratch,'case-'));
  await mkdir(join(root,'v1'));
  await writeFile(join(root,'v1','app-settings.json'), JSON.stringify({intent:'off', prompt:'PLANTED_UI_PROMPT',
    token:'PLANTED_UI_TOKEN', name:'PLANTED_UI_HOST', limits:{dailyJobs:3}}));
  return {root, preview:await supportPreview({home:root})};
}

test('Your data makes Get help and the support preview action available', () => {
  const text = renderedText(renderFixture(Settings, {api:{}, data:{devices:{name:'Computer'}}, route:{id:'data'}}));
  assert.match(text, /Get help/);
  assert.match(text, /Preview support export/);
  assert.match(text, /Saving downloads this archive to your computer; it does not send it to support\./);
  assert.match(text, /It may identify your computer or jobs\./);
  assert.doesNotMatch(text, /Save support archive/);
});

test('mounted preview shows exact contents before the browser receives the same archive bytes', async () => {
  const {root, preview} = await snapshot(), requests = [], downloads = [];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, oldClick = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => {downloads.push({blob}); return 'blob:support-test';};
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {downloads.at(-1).filename = this.download;};
  try {
    const view = await mount(h(SupportExport, {api:{post:async (path, body) => {requests.push({path,body}); return preview;}}}));
    assert.equal(requests.length, 0, 'mount saves and collects nothing');
    assert.equal(view.button('Save support archive'), null);
    await click(view.button('Preview support export'));
    assert.equal(view.$('pre').textContent, preview.entries[0].body);
    assert.equal(document.activeElement, view.$('pre'));
    assert.equal(downloads.length, 0, 'preview does not save');
    assert.doesNotMatch(view.text(), /PLANTED_UI_/);
    await click(view.button('Save support archive'));
    assert.deepEqual(requests, [{path:'ops/diagnostics.preview', body:{}}], 'save makes no second request');
    assert.equal(downloads[0].filename, 'faravan-support.tar.gz');
    const bytes = Buffer.from(await downloads[0].blob.arrayBuffer());
    await writeFile(join(root,'ui-saved.tar.gz'), bytes, {mode:0o600});
    assert.deepEqual(await readFile(join(root,'ui-saved.tar.gz')), Buffer.from(preview.archiveBase64,'base64'));
    assert.equal(readArchiveFiles(bytes)[0].bytes.toString(), view.$('pre').textContent);
    assert.match(view.text(), /Download requested/);
  } finally {
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    window.HTMLAnchorElement.prototype.click = oldClick;
  }
});

test('a failed preview shows fixed copy and retries without exposing the server error', async () => {
  const {preview} = await snapshot(); let fails = true;
  const view = await mount(h(SupportExport, {api:{post:async () => {if (fails) throw new Error('PLANTED_UI_SECRET'); return preview;}}}));
  await click(view.button('Preview support export'));
  assert.match(view.$('[role="alert"]').textContent, /could not load/);
  assert.doesNotMatch(view.text(), /PLANTED_UI_SECRET/);
  assert.equal(view.button('Save support archive'), null);
  fails = false;
  await click(view.button('Preview support export'));
  assert.equal(view.$('[role="alert"]'), null);
  assert.equal(view.$('pre').textContent, preview.entries[0].body);
});

test('pending preview cannot be started twice and offers no save until it finishes', async () => {
  const {preview} = await snapshot(); let calls = 0, finish;
  const view = await mount(h(SupportExport, {api:{post:() => {calls++; return new Promise(resolve => {finish = resolve;});}}}));
  await click(view.button('Preview support export'));
  assert.equal(view.button('Preparing preview…').disabled, true);
  await forceClick(view.button('Preparing preview…'));
  assert.equal(calls, 1);
  assert.equal(view.button('Save support archive'), null);
  finish(preview); await flush();
  assert.ok(view.button('Save support archive'));
});

test('save failure can retry the same snapshot and Close removes the save action', async () => {
  const {preview} = await snapshot(); let fails = true, saves = 0;
  const view = await mount(h(SupportExport, {api:{post:async () => preview}, save:value => {
    assert.equal(value, preview); saves++; if (fails) throw new Error('PLANTED_UI_SECRET');
  }}));
  await click(view.button('Preview support export'));
  await click(view.button('Save support archive'));
  assert.match(view.$('[role="alert"]').textContent, /could not start/);
  assert.doesNotMatch(view.text(), /PLANTED_UI_SECRET/);
  fails = false;
  await click(view.button('Save support archive'));
  assert.equal(saves, 2);
  assert.equal(view.$('[role="alert"]'), null);
  await click(view.button('Close preview'));
  assert.equal(view.$('pre'), null);
  assert.equal(view.button('Save support archive'), null);
  assert.ok(view.button('Preview support export'));
});

test('P1-2 malformed preview blocks saving and never makes exact-content or privacy assurances',async()=>{
  const {preview}=await snapshot();
  for(const value of [
    {...preview,entries:[]},
    {...preview,entries:[{...preview.entries[0],body:null}]},
    {...preview,archiveBase64:'not base64'}
  ]) {
    const view=await mount(h(SupportExport,{api:{post:async()=>value}}));
    await click(view.button('Preview support export'));
    assert.match(view.text(),/This support preview could not be verified/);
    assert.equal(view.button('Save support archive'),null);
    assert.doesNotMatch(view.text(),/exact contents|Private content and sign-ins are excluded|Only support.json/);
    teardown();
  }
});
test('P1-2 independent archive bytes never acquire an exact-content assurance',async()=>{
  const {preview}=await snapshot();
  const value={...preview,archiveBase64:Buffer.from('different archive bytes').toString('base64')};
  let saved;
  const view=await mount(h(SupportExport,{api:{post:async()=>value},save:result=>{saved=result;}}));
  await click(view.button('Preview support export'));
  assert.match(view.text(),/Archive contents and privacy are not verified by this screen/);
  assert.doesNotMatch(view.text(),/exact contents|Private content and sign-ins are excluded/);
  assert.match(view.text(),/archive may contain different or additional data/);
  assert.equal(Boolean(view.$('[aria-label="Support archive contents"]')),false);
  await click(view.button('Save support archive'));
  assert.equal(saved,value);
});

test('R4 multiple text entries and decodable unpadded wrapped Base64 are accepted without correspondence claims',async()=>{
  let saved;
  const value={entries:[{body:'first'},{body:'second'}],archiveBase64:'Y Q'};
  const view=await mount(h(SupportExport,{api:{post:async()=>value},save:result=>{saved=result;}}));
  await click(view.button('Preview support export'));
  assert.deepEqual(view.$$('pre').map(node=>node.textContent),['first','second']);
  assert.match(view.text(),/archive may contain different or additional data/);
  await click(view.button('Save support archive'));assert.equal(saved,value);
});
test('refresh invalidates a prior support preview while pending and after failure',async()=>{
  const value={entries:[{body:'old'}],archiveBase64:'YQ=='};
  let calls=0,reject;
  const view=await mount(h(SupportExport,{api:{post:()=>++calls===1?Promise.resolve(value):new Promise((resolve,no)=>{reject=no;})}}));
  await click(view.button('Preview support export'));assert.ok(view.button('Save support archive'));
  await click(view.button('Refresh support preview'));
  assert.equal(Boolean(view.button('Save support archive')),false);
  reject(Error('failed'));await flush();
  assert.equal(Boolean(view.button('Save support archive')),false);
  assert.equal(Boolean(view.$('pre')),false);
});
test('save revalidates a previously displayed preview before download',async()=>{
  const value={entries:[{body:'old'}],archiveBase64:'YQ=='};let saves=0;
  const view=await mount(h(SupportExport,{api:{post:async()=>value},save:()=>{saves++;}}));
  await click(view.button('Preview support export'));
  value.archiveBase64='not base64';
  await click(view.button('Save support archive'));
  assert.equal(saves,0);assert.match(view.text(),/could not be verified/);
});

test('closing a focused support preview returns focus to its persistent opener', async () => {
  const value = {entries:[{body:'fixture'}], archiveBase64:'YQ=='};
  const view = await mount(h(SupportExport, {api:{post:async () => value}}));
  const opener = view.button('Preview support export');
  assert.ok(document.activeElement !== opener, 'mount does not steal focus');
  await click(opener);
  assert.ok(document.activeElement === view.$('pre'), 'opening focuses the preview');
  view.button('Close preview').focus();
  await click(view.button('Close preview'));
  assert.equal(view.$('pre'), null);
  assert.ok(document.activeElement === opener, 'Close returns focus to the opener');
  await click(opener);
  assert.ok(document.activeElement === view.$('pre'), 'reopening retains preview focus');
});
