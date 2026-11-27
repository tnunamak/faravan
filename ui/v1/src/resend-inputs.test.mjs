import test from 'node:test';
import assert from 'node:assert/strict';
import {resendResultDraft, RESELECT_FILES_LINE, SOURCE_UNKNOWN_LINE} from './resend-result.mjs';
import {resendJobDialog} from './jobs.jsx';
import {loadDraft, saveDraft, draftBody} from './compose-draft.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// "Send again" prepares a draft from what the finished job still records. It never sends by itself.
const COMMIT = 'a'.repeat(40);
const gitJob = {job_digest:'sha256:g', state:'failed', local:{agent:'codex', source:'github.com/acme/app.git @ aaaaaaaa'},
  job:{payload:{source:{kind:'git', url:'https://github.com/acme/app.git', commit:COMMIT, object_format:'sha1'}, working_directory:'packages/app'}}};
const filesJob = {job_digest:'sha256:f', state:'failed', local:{agent:'claude-code', source:'Uploaded files · 3 files'}, job:{payload:{source:{kind:'archive', artifact:{digest:'sha256:x'}}}}};
const folderJob = (source, extra = {}) => ({job_digest:'sha256:d', state:'failed', local:{agent:'codex', sourcePath:'/code/app', sourceBranch:'main', source, ...extra}, job:{payload:{source:{kind:'archive', artifact:{digest:'sha256:y'}}}}});
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {values, getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value), removeItem:key => values.delete(key)};
};
const KEY = 'faravan-compose-draft:c1';

test('a Git job keeps its repository URL, commit and working directory', () => {
  const out = resendResultDraft({current:null, prompt:'Fix it', sourceFolder:'', job:gitJob});
  assert.equal(out.sourceKind, 'git');
  assert.equal(out.gitUrl, 'https://github.com/acme/app.git');
  assert.equal(out.gitCommit, COMMIT);
  assert.equal(out.workingDirectory, 'packages/app');
  assert.equal(out.agent, 'codex');
  assert.equal(out.prompt, 'Fix it');
  assert.equal(out.sending, false);
  assert.deepEqual(draftBody(out, 'c1').git, {url:'https://github.com/acme/app.git', commit:COMMIT});
});

test('the Git branch is not kept by a finished job, so the draft leaves it blank and keeps the pinned commit', () => {
  const out = resendResultDraft({current:null, prompt:'', sourceFolder:'', job:gitJob});
  assert.equal(out.gitBranch, '');
  assert.match(out.gitCommit, /^[a-f0-9]{40}$/);
});

test('a list row that only knows the source is Git still opens as a Git draft', () => {
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'', job:{sourceKind:'git', local:{agent:'codex'}}});
  assert.equal(out.sourceKind, 'git');
  assert.equal(out.gitUrl, '');
  assert.equal(out.path, '');
});

test('a files or ZIP job opens as a files draft with no bytes and no folder path', () => {
  const out = resendResultDraft({current:null, prompt:'Use these', sourceFolder:'', job:filesJob});
  assert.equal(out.sourceKind, 'files');
  assert.deepEqual(out.files, []);
  assert.equal(out.zip, null);
  assert.equal(out.path, '');
  assert.equal(out.attachmentId ?? null, null);
  assert.equal(RESELECT_FILES_LINE, 'Choose the files again before sending this job.');
});

test('a folder job with uncommitted changes keeps that choice and its folder', () => {
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'/code/app', job:folderJob('app (folder, with uncommitted changes)')});
  assert.equal(out.sourceKind, 'folder');
  assert.equal(out.path, '/code/app');
  assert.equal(out.includeUncommitted, true);
});

test('a folder job without uncommitted changes keeps includeUncommitted off', () => {
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'/code/app', job:folderJob('app (folder)')});
  assert.equal(out.sourceKind, 'folder');
  assert.equal(out.path, '/code/app');
  assert.equal(out.includeUncommitted, false);
});

test('a job record that names no source through the signed job opens as no source', () => {
  const out = resendResultDraft({current:null, prompt:'Write a poem', sourceFolder:'', job:{local:{agent:'codex'}, job:{payload:{source:{kind:'none'}}}}});
  assert.equal(out.sourceKind, 'none');
  assert.equal(out.path, '');
});

test('control: a plain folder job and a no-source job open as they did before', () => {
  const folder = resendResultDraft({current:null, prompt:'p', sourceFolder:'/code/project', job:{local:{agent:'codex'}}});
  assert.equal(folder.sourceKind, 'folder');
  assert.equal(folder.path, '/code/project');
  const none = resendResultDraft({current:null, prompt:'p', sourceFolder:'/code/project', job:{sourceKind:'none', local:{}}});
  assert.equal(none.sourceKind, 'none');
  assert.equal(none.path, '');
});

test('control: an earlier send still waiting blocks preparing a Git request', () => {
  assert.throws(() => resendResultDraft({current:{sending:true}, prompt:'x', job:gitJob}), /earlier send/);
});

test('confirming for a Git job saves a reviewable draft, selects the circle and navigates without sending', () => {
  const storage = memoryStorage();
  let navigations = 0;
  const dialog = resendJobDialog({storage, jobCircle:'c1', job:gitJob, prompt:'Fix it', sourceFolder:'', navigate:() => {navigations++;}});
  dialog.onConfirm();
  assert.equal(navigations, 1);
  assert.equal(storage.getItem('faravan-compose-circle'), 'c1');
  const saved = loadDraft(storage, 'c1');
  assert.equal(saved.sourceKind, 'git');
  assert.equal(saved.gitUrl, 'https://github.com/acme/app.git');
  assert.equal(saved.gitCommit, COMMIT);
  assert.equal(saved.workingDirectory, 'packages/app');
  assert.equal(saved.sending, false);
  assert.equal(saved.uncertainSince, null);
  assert.deepEqual([...storage.values.keys()].filter(key => key.startsWith('faravan-compose-draft:')), [KEY]);
});

test('the dialog for a files job says to choose the files again, and the saved draft has no files', () => {
  const storage = memoryStorage();
  const dialog = resendJobDialog({storage, jobCircle:'c1', job:filesJob, prompt:'Use these', sourceFolder:'', navigate() {}});
  assert.match(renderedText(renderFixture(() => dialog.children, {})), /Choose the files again before sending this job\./);
  dialog.onConfirm();
  const saved = loadDraft(storage, 'c1');
  assert.equal(saved.sourceKind, 'files');
  assert.deepEqual(saved.files, []);
  assert.equal(saved.zip, null);
  assert.equal(saved.attachmentId, null);
});

test('the dialog for a Git job does not tell the person to choose files again', () => {
  const dialog = resendJobDialog({storage:memoryStorage(), jobCircle:'c1', job:gitJob, prompt:'x', sourceFolder:'', navigate() {}});
  assert.doesNotMatch(renderedText(renderFixture(() => dialog.children, {})), /Choose the files again/);
});

test('another tab saving a draft after the dialog opened stops the replacement and leaves that draft alone', () => {
  const storage = memoryStorage();
  let navigations = 0;
  const dialog = resendJobDialog({storage, jobCircle:'c1', job:gitJob, prompt:'Fix it', sourceFolder:'', navigate:() => {navigations++;}});
  saveDraft(storage, 'c1', {id:'other-tab-draft', prompt:'Work from another tab', sourceKind:'none', path:''});
  const before = storage.getItem(KEY);
  assert.throws(() => dialog.onConfirm(), /saved or pending request/);
  assert.equal(storage.getItem(KEY), before);
  assert.equal(navigations, 0);
});

test('a pending send or uncertain draft for a Git job is not replaced', () => {
  for (const extra of [{sending:true}, {uncertainSince:123}, {agentRefusal:{label:'Busy', message:'Wait'}}]) {
    const storage = memoryStorage();
    saveDraft(storage, 'c1', {id:'pending-draft', prompt:'', sourceKind:'none', path:'', ...extra});
    const before = storage.getItem(KEY);
    let navigations = 0;
    const dialog = resendJobDialog({storage, jobCircle:'c1', job:gitJob, prompt:'x', sourceFolder:'', navigate:() => {navigations++;}});
    assert.throws(() => dialog.onConfirm(), /saved or pending request/);
    assert.equal(storage.getItem(KEY), before);
    assert.equal(navigations, 0);
  }
});

test('control: a browser that cannot save the new draft refuses and does not navigate', () => {
  const storage = memoryStorage();
  storage.setItem = () => {};
  let navigations = 0;
  const dialog = resendJobDialog({storage, jobCircle:'c1', job:gitJob, prompt:'x', sourceFolder:'', navigate:() => {navigations++;}});
  assert.throws(() => dialog.onConfirm(), /save the new request/);
  assert.equal(navigations, 0);
});

// A record that names no source kind and no folder: nothing says what the job used, so Send again guesses nothing.
const olderRecord = {job_digest:'sha256:older-upload', state:'failed', borrowerCircle:'c1', local:{agent:'codex', source:'Uploaded files · 3 files'}};

test('an older record with no source identity opens with no source chosen and says so', () => {
  const out = resendResultDraft({current:null, prompt:'Again', sourceFolder:'', job:olderRecord});
  assert.equal(out.sourceUnknown, true);
  assert.equal(out.path, '');
  assert.equal(out.agent, 'codex');
});

test('the dialog for an older record says Faravan could not tell what the job used', () => {
  const dialog = resendJobDialog({storage:memoryStorage(), jobCircle:'c1', job:olderRecord, prompt:'x', sourceFolder:'', navigate() {}});
  assert.equal(SOURCE_UNKNOWN_LINE, 'Choose what to send again. Faravan could not tell what this job used.');
  assert.match(renderedText(renderFixture(() => dialog.children, {})), /Choose what to send again\. Faravan could not tell what this job used\./);
});

test('the no-source-chosen mark survives saving and loading the draft', () => {
  const storage = memoryStorage();
  resendJobDialog({storage, jobCircle:'c1', job:olderRecord, prompt:'x', sourceFolder:'', navigate() {}}).onConfirm();
  assert.equal(loadDraft(storage, 'c1').sourceUnknown, true);
});

test('control: Git, folder, files and no-source records do not carry the no-source-chosen mark', () => {
  for (const [job, sourceFolder] of [[gitJob, ''], [filesJob, ''], [folderJob('app (folder)'), '/code/app'], [{sourceKind:'none', local:{}}, ''], [{local:{agent:'codex'}}, '/code/project']]) {
    const out = resendResultDraft({current:null, prompt:'x', sourceFolder, job});
    assert.notEqual(out.sourceUnknown, true);
  }
  for (const job of [gitJob, filesJob])
    assert.doesNotMatch(renderedText(renderFixture(() => resendJobDialog({storage:memoryStorage(), jobCircle:'c1', job, prompt:'x', sourceFolder:'', navigate() {}}).children, {})), /could not tell/);
});

test('a follow-up job record is read like any other: its recorded kind and folder decide the draft', () => {
  const followup = {job_digest:'sha256:fu', state:'failed', local:{agent:'codex', sourcePath:'/code/app'}, job:{payload:{source:{kind:'archive', artifact:{digest:'sha256:z'}}}}, followup:{parentJob:'sha256:p', parentResult:'sha256:r'}};
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'/code/app', job:followup});
  assert.equal(out.sourceKind, 'folder');
  assert.equal(out.path, '/code/app');
  assert.equal(out.followup, undefined);
  assert.notEqual(out.sourceUnknown, true);
});

test('a recorded folder kind with no usable folder asks the person to choose', () => {
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'', job:{sourceKind:'folder', local:{}}});
  assert.equal(out.sourceUnknown, true);
  assert.equal(out.path, '');
});

for (const sourceFolder of ['', '   ', undefined]) {
  for (const kind of ['folder', 'archive']) {
    test('a usable local folder survives a blank explicit folder: ' + kind + ' / ' + JSON.stringify(sourceFolder), () => {
      const job = folderJob('app (folder, with uncommitted changes)');
      job.sourceKind = kind;
      const out = resendResultDraft({current:null, prompt:'x', sourceFolder, job});
      assert.equal(out.path, '/code/app');
      assert.equal(out.includeUncommitted, true);
      assert.notEqual(out.sourceUnknown, true);
      assert.equal(draftBody(out, 'c1').repo.path, '/code/app');
    });
  }
}

test('a usable explicit folder takes precedence over the local folder', () => {
  const out = resendResultDraft({current:null, prompt:'x', sourceFolder:'  /code/chosen  ', job:folderJob('app (folder)')});
  assert.equal(out.path, '/code/chosen');
  assert.notEqual(out.sourceUnknown, true);
});
