import test from 'node:test';
import assert from 'node:assert/strict';
import {ApplyBody,ApplySheet} from './apply-sheet.jsx';
import {showBranchCommandVM,defaultApplyBranchVM} from './view-models.mjs';
import {AppliedCard} from './job-view.jsx';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';

// U22: the sheet's states as strings (no browser): the form, the preview, a changed repository and each refusal.
const summary = {job_digest:'sha256:' + '3f9a1c'.padEnd(64, '0'), branch:'faravan/3f9a1c2b7d10', base:'8d01e4a' + 'a'.repeat(33), repo:'/home/ana/code/booking-site', head:'b'.repeat(40), current_branch:'feature/checkout', preview_token:'signed-preview', patch_hash:'d'.repeat(64),
  files:2, files_changed:[{path:'src/form.tsx', insertions:18, deletions:4}, {path:'src/validate.ts', insertions:31, deletions:0}]};
const body = (over = {}) => renderFixture(ApplyBody, {phase:'form', repo:'', branch:'', summary:null, refusal:null, context:{}, lender:'Ana', digest:summary.job_digest, onRepo() {}, onBranch() {}, ...over,context:{...over.context,surface:'desktop',capabilities:{localApp:true}}});

test('the form asks for the folder first and shows nothing it does not know', () => {
  const out = body();
  assertDomOrder(out, ['Add as a branch', '<b>Repository folder</b>', 'aria-label="Repository folder"']);
  assert.doesNotMatch(renderedText(out), /Adds the branch|files change|undefined/);
});

test('the preview shows the repository, branch, sent version, current branch, files and branch name field, in that order', () => {
  const out = body({phase:'preview', repo:summary.repo, branch:summary.branch, summary});
  assertDomOrder(out, ['Adds the branch', '<b>faravan/3f9a1c2b7d10</b>', '<b>booking-site</b>', 'It starts from the version you sent.', 'feature/checkout', '2 files change:', 'src/form.tsx', '+18', '−4', 'src/validate.ts', 'The result from Ana will be saved on the new branch.', '<b>Branch name</b>', 'aria-label="Branch name"']);
  assert.match(out, /value="faravan\/3f9a1c2b7d10"/);
});

test('a repository that changed says so, shows the new state and promises nothing was written', () => {
  const text = renderedText(body({phase:'changed', repo:summary.repo, branch:summary.branch, summary}));
  assert.match(text, /The repository changed since you looked\. Here is what it looks like now\. Nothing was written\./);
  assert.match(text, /Adds the branch/);
});

test('a refusal is an alert with its next action; the other states have none', () => {
  const ctx = {repo:summary.repo, base:summary.base, branch:summary.branch};
  const missing = body({phase:'refused', repo:'/gone', refusal:{state:'job.apply-repo-missing', code:'repo_missing'}, context:{repo:'/gone'}});
  assert.match(missing, /role="alert"/);
  assert.match(renderedText(missing), /That folder is no longer a Git project\. Choose the folder where the project is now\. Change the folder Copy details/);
  const exists = renderedText(body({phase:'refused', repo:summary.repo, refusal:{state:'job.apply-branch-exists', code:'branch_exists'}, context:ctx}));
  assert.match(exists, /That branch name is already here\. Review the existing branch or choose another name\. Use another name/);
  assert.match(renderedText(body({phase:'refused', repo:summary.repo, refusal:{state:'job.apply-conflict', code:'patch_conflict'}, context:ctx})), /Nothing was added\. Download the patch/);
  assert.doesNotMatch(body({phase:'preview', repo:summary.repo, branch:summary.branch, summary}), /role="alert"/);
});

test('Added: the branch and folder, with commands available on request', () => {
  const out = renderFixture(AppliedCard, {applied:{branch:'faravan/3f9a1c2b7d10', repo:'/home/ana/code/booking-site'}});
  assert.match(renderedText(out), /Added as branch faravan\/3f9a1c2b7d10 .*in booking-site\. Switch to it there\. Show the switch-branch command Open a terminal in booking-site ?, then switch to the branch to review and test it\. \$ git switch faravan\/3f9a1c2b7d10/);
  assert.match(out, /aria-label="Copy command"/);
});


test('branch-exists recovery has an editable name and a safely quoted branch inspection command', () => {
  const out = body({phase:'refused',repo:'/code/my project',branch:'faravan/result',refusal:{state:'job.apply-branch-exists'},context:{branch:'faravan/result'}});
  assert.match(out, /aria-label="Branch name"/);
  assert.match(renderedText(out), /Show the inspect-branch command/);
  assert.match(out, /<details class="job-details"><summary>Show the inspect-branch command<\/summary><div[^>]*><span[^>]*>\$<\/span><code>git -C '\/code\/my project' show --stat faravan\/result<\/code>/);
  assert.match(renderedText(out), /Copy details/);
  assert.equal(showBranchCommandVM('/code/my project','faravan/result'), "git -C '/code/my project' show --stat faravan/result");
});

test('no-change refusal offers a follow-up and ambiguous apply failure makes no write promise', () => {
  assert.match(renderedText(body({phase:'refused',refusal:{state:'job.no-changes'}})), /Send a follow-up job/);
  const text = renderedText(body({phase:'refused',refusal:{state:'job.apply-failed'}}));
  assert.match(text, /could not confirm whether the branch was added/);
  assert.doesNotMatch(text, /Nothing was added/);
});

test('an occupied preview lock offers a safe recovery check', () => {
  const text = renderedText(body({phase:'refused', refusal:{state:'job.apply-lock-blocked', code:'preview_lock_blocked'}}));
  assert.match(text, /lock/);
  assert.match(text, /Recover preview locks/);
});


test('a branch refusal keeps the attempted branch while a replacement is typed', () => {
  assert.equal(defaultApplyBranchVM('sha256:'+'c'.repeat(64)), 'faravan/'+'c'.repeat(12));
  const text=renderedText(body({phase:'refused',repo:'/repo',branch:'new-name',refusal:{state:'job.apply-branch-exists',branch:'existing-name'},context:{branch:'new-name'}}));
  assert.match(text,/That branch name is already here/);
  assert.match(text,/git -C \/repo show --stat existing-name/);
});

import {applyWriteRecord} from './result-actions.mjs';
import {readFile} from 'node:fs/promises';

// Run the production async handler with deferred I/O, without a browser or a copied implementation.
const sheetSource = await readFile(new URL('./apply-sheet.jsx', import.meta.url), 'utf8');
const previewSource = sheetSource.match(/  async function preview\(next = \{\}\) \{[\s\S]*?\n  \}\n  async function add/)[0].replace(/\n  async function add$/, '');
test('checking an already published Apply reports the original success once', async () => {
  const applied = [], remembered = [], previews = [];
  const result = { ...summary, status: 'applied', commit: 'c'.repeat(40) };
  const context = { blocked:()=>false, write:{clear() {}}, adding:{current:false}, setCopyState() {}, currentRepo: { current: summary.repo }, branch: summary.branch,
    generation: { current: 0 }, mounted: { current: true }, jobId: summary.job_digest, defaultApplyBranchVM,
    call: async () => result, remember: value => remembered.push(value), onApplied: value => applied.push(value),
    setSummary: value => previews.push(value), setBusy() {}, setRefusal() {}, setPhase() {}, setBranch() {},
  };
  const preview = new Function(...Object.keys(context), previewSource + '; return preview;')(...Object.values(context));
  await preview();
  assert.deepEqual(applied, [result]);
  assert.deepEqual(remembered, [summary.repo]);
  assert.deepEqual(previews, [null], 'the recovered branch is not offered as a new preview');
});
const addSource = sheetSource.match(/  async function add\(\) \{[\s\S]*?\n  \}\n  async function recover/)[0].replace(/\n  async function recover$/, '');
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
function addHarness() {
  const api={}, write=applyWriteRecord(api,'circle','job'), applied=[], remembered=[], sent=[];
  const generation={current:0};
  const state={busy:false,phase:'preview',summary:null,refusal:null,branch:'result'};
  function start(repo, submit=true) {
    const currentRepo={current:repo}, mounted={current:true}, pending=deferred();
    const preview={...summary,repo,requestedRepo:repo,branch:'result'};
    let submitted;
    const context={write, writeState:null, blocked:()=>['pending','uncertain','reconciling','applied'].includes(write.state?.phase),
      adding:{current:false},setWriteState(value) {state.write=value;},setCopyState() {},setRepo(value) {state.repo=value;},
      onClose() {state.closed=true;},busy:false,summary:preview,branch:'result',generation,currentRepo,mounted,
      call:body=>{submitted=body;sent.push(body);return pending.promise;},remember:value=>remembered.push(value),onApplied:value=>applied.push(value),
      setBusy:value=>{state.busy=value;},setSummary:value=>{state.summary=value;},
      setRefusal:value=>{state.refusal=value;},setPhase:value=>{state.phase=value;},setBranch:value=>{state.branch=value;}};
    const evaluate = source => new Function(...Object.keys(context),source)(...Object.values(context));
    const lifecycle = sheetSource.slice(sheetSource.indexOf('    mounted.current = true;'),sheetSource.indexOf('  }, [write]);'));
    const unmount=evaluate(lifecycle);
    const run=evaluate(addSource+';return add;');
    const edits = sheetSource.match(/  function changeRepo\(value\) \{[\s\S]*?\n  useEffect/)[0].replace(/\n  useEffect$/, '');
    const close = sheetSource.match(/  const close = \(\) => \{[^\n]+/)[0];
    const actions=evaluate(edits+close+';return {changeRepo,changeBranch,close};');
    const opening = sheetSource.slice(sheetSource.indexOf('// Opening with a remembered folder')).match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[open\]\)/)[1];
    const openChanged=new Function(...Object.keys(context),'open',opening).bind(null,...Object.values(context));
    return {...pending,...actions,unmount,openChanged,run,done:submit?run():Promise.resolve(),get submitted(){return submitted;}};
  }
  return {api,generation,state,applied,remembered,sent,write,start};
}
const applyTarget={repo:'/A',branch:'result',job_digest:summary.job_digest,base:summary.base,patch_hash:summary.patch_hash};
const appliedA={...applyTarget,status:'applied',commit:'c'.repeat(40)};
const refused=()=>Object.assign(new Error('refused'),{outcome:'not_applied',refused:{state:'job.apply-conflict',code:'patch_conflict'}});
test('Add submits the preview token that authorized the displayed branch', async () => {
  const h=addHarness(), request=h.start('/A');
  request.resolve(appliedA);await request.done;
  assert.deepEqual(h.applied,[appliedA]);
  assert.deepEqual(request.submitted,{repo:'/A',dry_run:false,branch:'result',expect:{preview_token:'signed-preview'}});
});
for (const outcome of ['applied','changed','refused']) {
  test('unmount retains Add A '+outcome+' and prevents Add B or same-folder overlap', async () => {
    const h=addHarness(), a=h.start('/A');
    a.unmount();
    const b=h.start('/B');await b.done;
    const same=h.start('/A');await same.done;same.unmount();
    assert.equal(h.sent.length,1);
    assert.equal(b.submitted,undefined);
    assert.equal(h.state.busy,true);
    assert.equal(h.state.repo,'/A');
    assert.equal(h.state.branch,'result');
    if(outcome==='refused')a.reject(refused());
    else a.resolve({...appliedA,status:outcome,preview_token:'next-token'});
    await a.done;
    assert.equal(h.state.busy,false);
    if(outcome==='applied') {
      assert.deepEqual(h.applied,[{...appliedA,preview_token:'next-token'}]);
      assert.deepEqual(h.remembered,['/A']);
    } else {
      assert.equal(h.state.phase,outcome);
      assert.equal(h.write.state.target.repo,'/A');
      if(outcome==='changed')assert.equal(h.state.summary.preview_token,'next-token');
      else assert.equal(h.state.refusal.code,'patch_conflict');
    }
    b.unmount();
  });
}
test('receipt arriving with no sheet mounted is delivered on remount, once', async () => {
  const h=addHarness(), a=h.start('/A');a.unmount();
  a.resolve(appliedA);await a.done;
  assert.deepEqual(h.applied,[]);
  assert.deepEqual(h.write.state.receipt,appliedA);
  const b=h.start('/B',false);
  assert.deepEqual(h.applied,[appliedA]);assert.equal(h.state.repo,'/A');
  b.unmount();h.start('/A',false);
  assert.deepEqual(h.applied,[appliedA]);
});
test('unknown write stays locked across remount and reconciles only the submitted target',async()=>{
  const h=addHarness(), a=h.start('/A');a.unmount();
  a.reject(new Error('connection lost'));await a.done;
  const b=h.start('/B');await b.done;
  assert.equal(h.write.state.phase,'uncertain');assert.equal(h.sent.length,1);
  assert.equal(h.write.clear(),false);
  assert.equal(h.state.repo,'/A');assert.equal(h.state.branch,'result');
  const reads=[], pending=deferred();
  const checking=h.write.reconcile(body=>{reads.push(body);return pending.promise;});
  assert.equal(await h.write.reconcile(()=>assert.fail('overlapping reconciliation')),false);
  assert.equal(await h.write.submit({},()=>assert.fail('overlapping write')),false);
  pending.resolve({...appliedA,status:'dry_run'});await checking;
  assert.equal(h.write.state.phase,'uncertain');
  await h.write.reconcile(async body=>{reads.push(body);return {...appliedA,repo:'/B'};});
  assert.equal(h.write.state.phase,'uncertain');assert.deepEqual(h.applied,[]);
  await h.write.reconcile(async body=>{reads.push(body);return appliedA;});
  assert.deepEqual(reads,Array(3).fill({repo:'/A',branch:'result',dry_run:true}));
  assert.deepEqual(h.applied,[appliedA]);assert.equal(h.write.state,null);
});
test('a mismatched success is uncertain and record identities do not bleed',async()=>{
  const api={},record=applyWriteRecord(api,'circle','job');
  assert.equal(record,applyWriteRecord(api,'circle','job'));
  assert.notEqual(record,applyWriteRecord(api,'other','job'));
  assert.notEqual(record,applyWriteRecord(api,'circle','other'));
  assert.notEqual(record,applyWriteRecord({},'circle','job'));
  await record.submit(applyTarget,async()=>({...appliedA,branch:'other'}));
  assert.equal(record.state.phase,'uncertain');
  assert.equal(record.state.target.branch,'result');
  assert.equal(record.clear(),false);
});

test('branch editor stays mounted after preview invalidation for every typed character', () => {
  for (const branch of ['n','ne','new-name']) {
    const out=body({phase:'form',branch,summary:null,refusal:null});
    assert.match(out,/aria-label="Branch name"/);
    assert.match(out,new RegExp('value="'+branch+'"'));
  }
});
test('pending writes disable both editors', () => {
  const out=body({adding:true,phase:'preview',summary,branch:summary.branch});
  assert.match(out,/<input[^>]*aria-label="Repository folder"[^>]*disabled/);
  assert.match(out,/<input[^>]*aria-label="Branch name"[^>]*disabled/);
});
for (const outcome of ['applied','refused']) test('edit and close attempts retain a delayed '+outcome+' write outcome',async()=>{
  const h=addHarness(), request=h.start('/A');
  request.changeRepo('/B');request.changeBranch('other');request.close();
  assert.equal(h.generation.current,1);
  assert.equal(h.state.closed,undefined);
  assert.equal(h.state.busy,true);
  if(outcome==='applied')request.resolve(appliedA);
  else request.reject(refused());
  await request.done;
  assert.equal(h.state.busy,false);
  if(outcome==='applied')assert.deepEqual(h.applied,[appliedA]);
  else {assert.equal(h.state.phase,'refused');assert.equal(h.state.refusal.code,'patch_conflict');}
});
test('details copy reports unavailable, rejected and successful clipboard outcomes',async()=>{
  const source=sheetSource.match(/  async function copyDetails\(\) \{[\s\S]*?\n  \}/)[0];
  for(const outcome of ['unavailable','rejected','copied']){
    const states=[],writes=[],detailsText='{"code":"safe"}';
    const navigator=outcome==='unavailable'?{}:{clipboard:{async writeText(value){writes.push(value);if(outcome==='rejected')throw new Error('denied');}}};
    const copy=new Function('globalThis','detailsText','setCopyState',source+';return copyDetails;')({navigator},detailsText,value=>states.push(value));
    await copy();
    assert.deepEqual(states,['copying',outcome==='copied'?'copied':'failed']);
    if(outcome!=='unavailable')assert.deepEqual(writes,[detailsText]);
  }
});
test('copy feedback exposes only the supplied safe details and offers manual copy on failure',()=>{
  const refusal={state:'job.apply-failed'};
  assert.match(renderedText(body({refusal,copyState:'copying'})),/Copying details/);
  assert.match(renderedText(body({refusal,copyState:'copied'})),/Details copied/);
  const out=body({refusal,copyState:'failed',detailsText:'safe-details'});
  assert.match(renderedText(out),/Try Copy details again/);
  assert.match(out,/aria-label="Details to copy manually"/);
  assert.match(out,/safe-details/);
});

test('external open=false preserves a pending refusal and it can then be closed',async()=>{
 const h=addHarness(), request=h.start('/A');
 request.openChanged(false);
 assert.equal(h.generation.current,1);
 assert.equal(h.state.busy,true);
 request.reject(refused());
 await request.done;
 assert.equal(h.state.phase,'refused');
 assert.match(sheetSource,/open=\{open \|\| !!writeState \|\| phase === 'refused' \|\| phase === 'changed'\}/);
 request.close();
 assert.equal(h.state.phase,'form');
 assert.equal(h.state.refusal,null);
 assert.equal(h.state.closed,true);
});

test('receipt publication reaches both subscribers before successful acknowledgement',async()=>{
  const record=applyWriteRecord({},'circle','job'), seen=[[],[]], deliveries=[], clears=[], duplicates=[];
  let delivered;
  record.subscribe(state=>{
    seen[0].push(state?.phase ?? null);
    if(state?.phase==='applied') {
      clears.push(record.clear());
      delivered=record.deliver(receipt=>deliveries.push(receipt));
    }
  });
  record.subscribe(state=>{
    seen[1].push(state?.phase ?? null);
    if(state?.phase==='applied')record.deliver(()=>duplicates.push('duplicate'));
  });
  await record.submit(applyTarget,async()=>appliedA);
  await delivered;
  assert.deepEqual(seen,[['pending','applied',null],['pending','applied',null]].map(states=>[null,...states]));
  assert.deepEqual(deliveries,[appliedA]);
  assert.deepEqual(clears,[false]);assert.deepEqual(duplicates,[]);
  assert.equal(record.state,null);
});
test('reentrant clear publishes terminal state before the cleared state to every observer',async()=>{
  const record=applyWriteRecord({},'circle','job'), seen=[];
  record.subscribe(state=>{if(state?.phase==='changed')record.clear();});
  record.subscribe(state=>seen.push(state?.phase ?? null));
  await record.submit(applyTarget,async()=>({...appliedA,status:'changed',preview_token:'next'}));
  assert.deepEqual(seen,[null,'pending','changed',null]);
});
test('throwing observers and failed delivery retain receipt and lock until successful retry',async()=>{
  const record=applyWriteRecord({},'circle','job'), seen=[];
  const unsubscribe=record.subscribe(()=>{throw new Error('observer failed');});
  assert.equal(typeof unsubscribe,'function');
  record.subscribe(state=>seen.push(state?.phase ?? null));
  await record.submit(applyTarget,async()=>appliedA);
  assert.deepEqual(seen,[null,'pending','applied']);
  for(const consume of [()=>{throw new Error('callback failed');},async()=>{throw new Error('async callback failed');}]) {
    assert.equal(await record.deliver(consume),false);
    assert.deepEqual(record.state.receipt,appliedA);
    assert.equal(record.clear(),false);
    assert.equal(await record.submit({},()=>assert.fail('write before delivery')),false);
  }
  unsubscribe();
  const pending=deferred(), delivered=[], parallel=[];
  const delivery=record.deliver(async receipt=>{delivered.push(receipt);await pending.promise;});
  assert.equal(await record.deliver(()=>parallel.push('unexpected')),false);
  assert.deepEqual(parallel,[]);
  assert.equal(await record.submit({},()=>assert.fail('write during delivery')),false);
  pending.resolve();assert.equal(await delivery,true);
  assert.equal(record.state,null);assert.deepEqual(delivered,[appliedA]);
  assert.deepEqual(seen,[null,'pending','applied',null]);
});

for (const [field, value] of [
  ['job_digest', undefined], ['job_digest', 'sha256:'+'e'.repeat(64)],
  ['patch_hash', undefined], ['patch_hash', 'e'.repeat(64)],
  ['base', undefined], ['base', 'e'.repeat(40)],
  ['commit', undefined], ['commit', 'not-a-commit'],
]) for (const phase of ['submit', 'reconcile']) {
  test(phase+' keeps a same-name receipt with mismatched '+field+'='+value+' uncertain', async()=>{
    const record=applyWriteRecord({},'circle',summary.job_digest), delivered=[];
    const wrong={...appliedA,[field]:value};
    if(phase==='submit') await record.submit(applyTarget,async()=>wrong);
    else {
      await record.submit(applyTarget,async()=>{throw new Error('connection lost');});
      await record.reconcile(async()=>wrong);
    }
    assert.equal(record.state.phase,'uncertain');
    assert.equal(record.clear(),false);
    assert.equal(await record.deliver(out=>delivered.push(out)),false);
    assert.deepEqual(delivered,[]);
    assert.equal(await record.submit(applyTarget,()=>assert.fail('duplicate write')),false);
    await record.reconcile(async()=>appliedA);
    assert.equal(record.state.phase,'applied');
    assert.equal(await record.deliver(out=>delivered.push(out)),true);
    assert.deepEqual(delivered,[appliedA]);
  });
}


// Default-visible text excludes the body of native, initially closed disclosures.
function mainApplyText(html) {
  return renderedText(html.replace(/<details\b([^>]*)>([\s\S]*?)<\/details>/g,
    (all, attributes, inside) => /\bopen(?:\s|=|$)/.test(attributes) ? all
      : inside.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] || ''));
}
function assertCommandsDisclosed(html, names=['Show the add-branch command']) {
  const disclosures=[...html.matchAll(/<details\b(?![^>]*\bopen\b)[^>]*><summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
  assert.deepEqual(disclosures.map(match=>match[1]),names);
  for(const disclosure of disclosures) {
    const command=renderedText(disclosure[2]);
    if(disclosure[1]==='Show the add-branch command') {
      assert.match(command,/faravan apply\b/);
      assert.doesNotMatch(command,/git .*show --stat/);
    } else if(disclosure[1]==='Show the inspect-branch command') {
      assert.match(command,/git .*show --stat/);
      assert.doesNotMatch(command,/faravan apply\b/);
    } else if(disclosure[1]==='Show the switch-branch command') {
      assert.match(command,/\bgit switch result\b/);
      assert.doesNotMatch(command,/faravan apply\b|git .*show --stat/);
    } else assert.fail('Unexpected command disclosure: '+disclosure[1]);
  }
  assert.match(renderedText(html), /\b(?:git|faravan apply)\b/);
  assert.doesNotMatch(mainApplyText(html), /\b(?:git|faravan apply)\b/);
}

test('apply preview keeps hashes out of the main view and uses short branch names', () => {
  const out=body({phase:'preview',repo:summary.repo,branch:summary.branch,
    sourceBranch:'refs/heads/feature/source',summary:{...summary,current_branch:'refs/heads/feature/checkout'}});
  const text=mainApplyText(out);
  assert.match(text,/It starts from the version of feature\/source you sent/);
  assert.match(text,/current branch \(feature\/checkout\)/);
  for(const hash of [summary.base,summary.base.slice(0,7),summary.head])assert.ok(!text.includes(hash),hash);
  assert.doesNotMatch(text,/refs\/heads\//);
});

test('apply and added-result commands are behind initially closed disclosures', () => {
  assertCommandsDisclosed(body({phase:'preview',repo:summary.repo,branch:summary.branch,summary}));
  assertCommandsDisclosed(body({phase:'refused',repo:summary.repo,branch:summary.branch,
    refusal:{state:'job.apply-branch-exists'},context:{branch:summary.branch}}),['Show the inspect-branch command','Show the add-branch command']);
  assertCommandsDisclosed(renderFixture(AppliedCard,{applied:{branch:'result',repo:summary.repo}}),['Show the switch-branch command']);
});

for(const phase of ['form','pending','uncertain','reconciling','applied']) {
  test('rendered apply sheet uses plain words in '+phase,async()=>{
    const api={},circle='plain-copy',jobId=summary.job_digest,record=applyWriteRecord(api,circle,jobId);
    let pending;
    if(phase==='pending') {pending=deferred();void record.submit(applyTarget,()=>pending.promise);}
    if(['uncertain','reconciling'].includes(phase))await record.submit(applyTarget,async()=>{throw new Error('Connection interrupted');});
    if(phase==='reconciling'){pending=deferred();void record.reconcile(()=>pending.promise);}
    if(phase==='applied')await record.submit(applyTarget,async()=>appliedA);
    const html=renderFixture(ApplySheet,{open:true,api,circle,jobId,sourceFolder:'/editable-draft',onClose(){}});
    const text=renderedText(html);
    const labels=[...html.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match=>match[1]).join(' ');
    assert.doesNotMatch(text+' '+labels,/\b(verdict|receipt|attempt|settled|lease|reconciled)\b/i);
    if(['uncertain','reconciling'].includes(phase)) {
      assert.match(text,/Check the submitted branch/);
      assert.match(text,/Do not add it again until the original write is checked/);
      assert.match(text,/Could not confirm whether result was added in \/A\. Do not add it again until the original write is checked\./);
      assert.match(text,/This sheet stays open until the write is checked\./);
      assertCommandsDisclosed(html,['Show the add-branch command','Show the inspect-branch command']);
      const inspection=[...html.matchAll(/<details\b[^>]*><summary>Show the inspect-branch command<\/summary>([\s\S]*?)<\/details>/g)];
      assert.equal(inspection.length,1);
      assert.match(renderedText(inspection[0][1]),/git -C \/A show --stat result/);
      assert.doesNotMatch(renderedText(inspection[0][1]),/\/editable-draft/);
    }
    if(phase==='pending')assert.match(text,/Adding the branch… This write has already been sent and cannot be cancelled\. Wait for its result before closing\./);
    if(phase==='applied') {
      assert.match(text,/Added result in \/A\. The saved result is retained until it can be shown\./);
      assert.match(text,/Show the added branch/);
    } else {
      assert.doesNotMatch(text,/\bAdded\b/);
      assert.doesNotMatch(text,/Show the added branch/);
    }
    if(pending)pending.resolve(appliedA);
  });
}

for(const phase of ['refused','changed']) {
  test('rendered '+phase+' retains its explanation without an Added announcement',async()=>{
    const h=addHarness(),request=h.start('/A');
    try {
      if(phase==='refused')request.reject(refused());
      else request.resolve({...summary,...appliedA,status:'changed'});
      await request.done;
      assert.equal(h.state.phase,phase);
      const html=body({phase:h.state.phase,repo:h.state.repo,branch:h.state.branch,
        summary:h.state.summary,refusal:h.state.refusal,context:{repo:'/A',branch:'result'}});
      const text=renderedText(html);
      if(phase==='changed')assert.match(text,/The repository changed since you looked\. Here is what it looks like now\. Nothing was written\./);
      else assert.match(text,/Nothing was added\. Download the patch/);
      assert.doesNotMatch(text,/\bAdded\b/);
      assert.doesNotMatch(text,/Show the added branch/);
      const sheet=renderedText(renderFixture(ApplySheet,{open:true,api:h.api,circle:'circle',
        jobId:'job',sourceFolder:'/A',onClose(){}}));
      assert.doesNotMatch(sheet,/\bAdded\b|Show the added branch/);
    } finally {request.unmount();}
  });
}
