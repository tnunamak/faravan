import test from 'node:test';
import assert from 'node:assert/strict';
import {editorLinksVM, workingTreePreviewVM, workingTreeRequestVM, resultActionRefusalVM, undoCommandVM, removeBranchVM} from './result-actions.mjs';
import {ResultActionsBody} from './result-actions.jsx';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';

const preview = (over = {}) => ({status:'dry_run', repo:'/home/ana/code/site', head:'b'.repeat(40), current_branch:'main', base:'a'.repeat(40), per_file:true,
  working_tree:{clean:true, changed:[], more:0},
  files:[{path:'src/a.ts', old_path:null, status:'modified', insertions:3, deletions:1, binary:false, state:'applies'},
    {path:'src/b.ts', old_path:null, status:'modified', insertions:2, deletions:0, binary:false, state:'merges'},
    {path:'src/c.ts', old_path:null, status:'modified', insertions:1, deletions:1, binary:false, state:'conflict'},
    {path:'.env', old_path:null, status:'added', insertions:1, deletions:0, binary:false, state:'exists'}], ...over});

test('editor links open the folder in VS Code and Cursor, only for absolute paths, with every segment encoded', () => {
  assert.deepEqual(editorLinksVM('/home/ana/my code/#1'), [
    {label:'VS Code', href:'vscode://file/home/ana/my%20code/%231/'}, {label:'Cursor', href:'cursor://file/home/ana/my%20code/%231/'}]);
  assert.equal(editorLinksVM('C:\\Users\\ana\\site')[0].href, 'vscode://file/C:/Users/ana/site/');
  assert.equal(editorLinksVM('/home/ana/site', 'src/a b.ts')[0].href, 'vscode://file/home/ana/site/src/a%20b.ts');
  for (const bad of ['', 'relative/x', '/x\0y', null, '/x/../y', 'javascript:alert(1)']) assert.deepEqual(editorLinksVM(bad), [], String(bad));
  assert.deepEqual(editorLinksVM('/x', '../etc/passwd'), []);
});

test('the preview: a file is checked by default only when it applies or merges; the rest say why not', () => {
  const vm = workingTreePreviewVM(preview());
  assert.deepEqual(vm.files.map(f => [f.path, f.selectable, f.word]), [
    ['src/a.ts', true, 'Applies cleanly'], ['src/b.ts', true, 'Merges with your commits'],
    ['src/c.ts', false, 'Conflicts with your version'], ['.env', false, 'A file is already there']]);
  assert.deepEqual(vm.defaultSelection, ['src/a.ts', 'src/b.ts']);
  assert.equal(vm.blocked, null);
  assert.match(vm.summary, /2 of 4 files can be applied to \/home\/ana\/code\/site on main/);
});

test('a dirty working tree blocks the apply and names the changed files', () => {
  const vm = workingTreePreviewVM(preview({working_tree:{clean:false, changed:['README.md', 'src/x.ts'], more:3}}));
  assert.match(vm.summary, /^This result changes 4 files in \/home\/ana\/code\/site on main\.$/);
  assert.match(vm.blocked, /5 files in this folder have uncommitted changes \(README\.md, src\/x\.ts and 3 more\)\. Commit or stash them first/);
  assert.match(workingTreePreviewVM(preview({working_tree:{clean:false, changed:['README.md'], more:0}})).blocked, /README\.md has uncommitted changes/);
});

test('without per-file checks only the whole result can be applied', () => {
  const vm = workingTreePreviewVM(preview({per_file:false, files:preview().files.slice(0, 2)}));
  assert.equal(vm.perFile, false);
  assert.match(vm.summary, /all 2 files/i);
});

test('the request sends null for "all files", the chosen paths otherwise, and what the preview showed', () => {
  const p = preview();
  assert.deepEqual(workingTreeRequestVM({circle:'c1', repo:' /home/ana/code/site ', preview:p, selection:['src/a.ts']}),
    {circle:'c1', repo:'/home/ana/code/site', dry_run:false, files:['src/a.ts'], expect:{head:p.head, current_branch:'main'}});
  const all = preview({files:p.files.slice(0, 2)});
  assert.equal(workingTreeRequestVM({circle:'c1', repo:'/r', preview:all, selection:['src/b.ts', 'src/a.ts']}).files, null);
  assert.deepEqual(workingTreeRequestVM({circle:'c1', repo:'/r', preview:null, selection:[]}), {circle:'c1', repo:'/r', dry_run:true});
});

test('each refusal code has its own words and says nothing was written; unknown codes fall back', () => {
  for (const code of ['dirty', 'path_exists', 'unsafe_path', 'patch_conflict', 'unknown_file', 'nothing_selected', 'too_many_files', 'repo_missing',
    'not_a_repository', 'repo_busy', 'unsafe_patch', 'write_failed', 'base_missing', 'branch_moved', 'not_our_commit', 'branch_checked_out', 'not_applied']) {
    const text = resultActionRefusalVM({code});
    assert.ok(text && !/undefined|null/.test(text), code);
  }
  assert.match(resultActionRefusalVM({code:'dirty'}), /Nothing was written/);
  assert.match(resultActionRefusalVM({code:'branch_moved'}), /left alone/);
  assert.match(resultActionRefusalVM({code:'mystery'}), /Check the current state/);
  assert.doesNotMatch(resultActionRefusalVM({code:'mystery'}), /Nothing was written/);
  assert.match(resultActionRefusalVM({code:'', message:'SECRET /home/private'}), /Check the current state/, 'unregistered prose cannot claim an outcome');
});

test('the undo command restores the changed files and removes the added ones, quoted for the shell', () => {
  assert.equal(undoCommandVM('/home/ana/code/site', {restore:["src/it's.ts", 'b.ts'], remove:['new file.ts']}),
    "git --literal-pathspecs -C /home/ana/code/site restore -- 'src/it'\\''s.ts' b.ts && rm -- '/home/ana/code/site/new file.ts'");
  assert.equal(undoCommandVM('/r', {restore:['-x'], remove:[]}), 'git --literal-pathspecs -C /r restore -- -x');
  assert.equal(undoCommandVM('/r', {restore:[], remove:[]}), '');
});

test('Remove this branch shows only for a recorded branch and says what it keeps', () => {
  assert.equal(removeBranchVM(null), null);
  const vm = removeBranchVM({branch:'faravan/3f9a', repo:'/home/ana/code/site', commit:'c'.repeat(40)});
  assert.match(vm.confirm, /Remove faravan\/3f9a from \/home\/ana\/code\/site\? Only this branch is removed/);
});

const body = (over = {}) => renderFixture(ResultActionsBody, {repo:'/home/ana/code/site', phase:'idle', preview:null, selection:[], refusal:null, applied:null, done:null, onRepo() {}, ...over});

test('the body: editor links and the apply form first; the preview lists files with their state; a blocked tree has no apply button', () => {
  const idle = body();
  assertDomOrder(idle, ['Open in', 'vscode://file/home/ana/code/site/', 'Apply to working tree', 'aria-label="Repository folder for apply"', 'Check the folder']);
  const shown = body({phase:'preview', preview:preview(), selection:['src/a.ts', 'src/b.ts']});
  assertDomOrder(shown, ['2 of 4 files', 'src/a.ts', 'Applies cleanly', 'src/b.ts', 'Merges with your commits', 'src/c.ts', 'Conflicts with your version', 'Apply 2 files']);
  assert.match(shown, /type="checkbox"[^>]*disabled/);
  const dirty = body({phase:'preview', preview:preview({working_tree:{clean:false, changed:['README.md'], more:0}}), selection:['src/a.ts']});
  assert.match(dirty, /role="alert"/);
  assert.doesNotMatch(renderedText(dirty), /Apply 1 file/);
});

test('the body: a changed repository, a refusal, a finished apply and Remove this branch', () => {
  assert.match(renderedText(body({phase:'changed', preview:preview(), selection:[]})), /The repository changed since you looked\. Here is what it looks like now\. Nothing was written\./);
  assert.match(body({phase:'refused', refusal:{code:'patch_conflict'}}), /role="alert"/);
  const done = renderedText(body({phase:'applied', done:{applied:['src/a.ts'], undo:{restore:['src/a.ts'], remove:[]}, repo:'/home/ana/code/site'}}));
  assert.match(done, /Applied 1 file to \/home\/ana\/code\/site\. Nothing was staged or committed\./);
  assert.match(done, /git --literal-pathspecs -C \/home\/ana\/code\/site restore -- src\/a\.ts/);
  const removable = renderedText(body({applied:{branch:'faravan/3f9a', repo:'/home/ana/code/site', commit:'c'.repeat(40)}}));
  assert.match(removable, /Remove this branch/);
  assert.doesNotMatch(renderedText(body()), /Remove this branch/);
});

test('P1-1 discard instructions warn about later edits immediately before the command', () => {
  const html = body({phase:'applied', done:{repo:'/r', applied:['a'], undo:{restore:['a']}}});
  assertDomOrder(html, ['Discard applied changes from the terminal',
    'This discards all current uncommitted changes in the listed files, including edits made after applying. Back up your work first. It cannot recover deleted file contents.',
    'git --literal-pathspecs']);
  assert.doesNotMatch(renderedText(html), /Undo it from the terminal/);
});

test('P1-2 applying locks target, check and selection and guards direct body handlers', async () => {
  const html = body({phase:'applying', submittedRepo:'/submitted', preview:preview(), selection:['src/a.ts']});
  assert.match(html, /aria-label="Repository folder for apply"[^>]*disabled/);
  assert.match(renderedText(html), /Applying to \/submitted — wait for the result before changing folders\./);
  let calls = 0;
  const noop = () => calls++;
  const tree = ResultActionsBody({repo:'/r', phase:'applying', preview:preview(), selection:['src/a.ts'],
    onRepo:noop, onCheck:noop, onToggle:noop, onApply:noop});
  const nodes = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    nodes.push(node); walk(node.props?.children);
  }
  walk(tree);
  const form = nodes.find(n => n.type === 'form');
  form.props.onSubmit({preventDefault() {}});
  const input = nodes.find(n => n.props?.['aria-label'] === 'Repository folder for apply');
  input.props.onInput({currentTarget:{value:'/other'}});
  for (const checkbox of nodes.filter(n => n.props?.type === 'checkbox')) checkbox.props.onChange();
  const applyButton = nodes.find(n => n.props?.pending === true && n.props?.onClick);
  applyButton.props.onClick();
  assert.equal(calls, 0, 'programmatic handlers must not bypass disabled controls');
  const module = await import('./result-actions.mjs');
  assert.equal(typeof module.createResultWriteGuard, 'function');
  const guard = module.createResultWriteGuard();
  assert.equal(guard.begin('applying'), true);
  assert.equal(guard.begin('applying'), false, 'same-tick duplicate write blocked');
  assert.equal(guard.acknowledge(), false, 'cannot unlock an in-flight write');
  guard.settle(false);
  assert.equal(guard.begin('applying'), false, 'uncertain write must be reconciled first');
  assert.equal(guard.acknowledge(), true);
  assert.equal(guard.begin('applying'), true);
});

test('P1-3 malformed receipts remain unconfirmed without rendering a success count', async () => {
  const module = await import('./result-actions.mjs');
  assert.equal(typeof module.confirmedWorkingTreeReceipt, 'function');
  for (const result of [null, {}, {repo:'/r'}, {repo:'/other',applied:['a']},
    {repo:'/r',applied:'a'}, {repo:'/r',applied:[]}, {repo:'/r',applied:['other']},
    {repo:'/r',applied:['a'],undo:{restore:'a'}}, {repo:'/r',applied:['a'],status:'dry_run'}]) {
    assert.equal(module.confirmedWorkingTreeReceipt(result, '/r', ['a']), null);
  }
  assert.deepEqual(module.confirmedWorkingTreeReceipt({repo:'/r',applied:['a']}, '/r', ['a']),
    {repo:'/r',applied:['a'],undo:undefined});
  const uncertain = renderedText(body({phase:'unconfirmed', submittedRepo:'/r', done:{response:{}}}));
  assert.match(uncertain, /The outcome is not confirmed\. Check the repository before trying again\./);
  assert.doesNotMatch(uncertain, /Applied \d+ file/);
  const removal = renderedText(body({applied:{repo:'/r',branch:'result'}, removal:{phase:'unconfirmed',repo:'/r',response:{}}}));
  assert.match(removal, /The outcome is not confirmed/);
  assert.doesNotMatch(removal, /Removed result/);
});

test('P2-1 affected-file preview discloses merged-content limits and renders rename and binary metadata', () => {
  const text = renderedText(body({phase:'preview', preview:preview({files:[
    {path:'new.png',old_path:'old.png',status:'renamed',binary:true,state:'merges'}]}),selection:['new.png']}));
  assert.match(text, /This lists affected files, not the final merged contents\. Review the result diff; files merged with your commits may differ\./);
  assert.match(text, /old\.png → new\.png/);
  assert.match(text, /renamed/);
  assert.match(text, /Binary/);
});

test('P2-2 missing or invalid working-tree evidence cannot select or apply files', () => {
  for (const tree of [undefined, null, {}, {clean:'true',changed:[]}, {clean:true},
    {clean:true,changed:['a'],more:0}, {clean:true,changed:[],more:-1}]) {
    const p = preview({working_tree:tree}), vm = workingTreePreviewVM(p);
    assert.equal(vm.blocked, 'Could not verify that this folder has no uncommitted changes. Check the folder again.');
    assert.deepEqual(vm.defaultSelection, []);
    assert.ok(vm.files.every(file => !file.selectable));
    const html = body({phase:'preview',preview:p,selection:['src/a.ts']});
    assert.doesNotMatch(renderedText(html), /Apply 1 file/);
  }
});

test('blocked working-tree advice never offers the unavailable branch action',()=>{
 for(const p of [preview({files:[{path:'outside',state:'unsafe'}]}),preview({per_file:false})]){
  const vm=workingTreePreviewVM(p);
  assert.match(vm.blocked,/Download the patch to inspect it without applying/);
  assert.doesNotMatch(vm.blocked,/branch/);
 }
});
