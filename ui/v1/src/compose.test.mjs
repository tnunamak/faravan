import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Compose, ComposeBody} from './compose.jsx';
import {composeVM, projectVM, whenWords, dateTimeWords, COMPOSE_REPO_STATES} from './view-models.mjs';
import {loadDraft, saveDraft, clearDraft, draftBody, sendUncertain, newDraftId, validRequestState} from './compose-draft.mjs';
import {signedRequestBlocker} from './compose-model.mjs';
import {renderFixture, renderedText, assertDomOrder, assertNoBannedWords} from './render.test-helper.mjs';
import {FIRST_SEND_COPY, circlePhrase} from './safety-copy.mjs';

// U7m: the MVP composer's four states, as strings and as a view-model, plus the draft that lives on this computer.
const NOW = Date.parse('2026-10-19T09:00:00Z');
const info = {path:'/home/sam/code/booking-site', name:'booking-site', branch:'main', head:'8d01e4a' + 'b'.repeat(33), files:212, changed:[{code:'M', path:'src/a.js'}, {code:'?', path:'notes.txt'}], changed_count:2};
const lenders = [{keyId:'a', label:'Ana’s MacBook'}, {keyId:'b', label:'Mo’s Mac'}];
const online = {id:'c1', name:'Weekend projects', state:{networked:true, host:{label:'Ana’s MacBook', reachable:true}, lenders}};
const offline = {...online, state:{...online.state, host:{label:'Ana’s MacBook', reachable:false, lastReachedAt:'2026-10-18T18:10:00Z'}}};
const draft = (over = {}) => ({id:'draft-0001-aaaa', prompt:'Reject a checkout before check-in.', path:info.path, includeUncommitted:false, agent:'', sending:false, ...over});
const vmOf = (over = {}) => composeVM({prompt:draft().prompt, repo:{status:'ok', info}, circle:online, draftSaved:true, now:NOW, zone:'UTC', ...over});
const page = (vm, over = {}) => renderFixture(ComposeBody, {vm, project:info, draft:draft(), circles:[], circle:'c1', agents:[{id:'claude-code-subscription'}, {id:'codex'}], onPrompt() {}, onPath() {}, onInclude() {}, onAgent() {}, onCircle() {}, onCheck() {}, onSend() {}, onCancel() {}, ...over});

test('compose.local: the project card, the uncommitted choice, the disclosure naming the lenders, and an enabled Send', () => {
  const vm = vmOf(), out = page(vm);
  assert.equal(vm.state, 'compose.local');
  assert.equal(vm.banner, null);
  assert.match(out, /<label class="cmp-field-title" for="cmp-prompt">What should the agent do\?<\/label>/);
  assert.match(out, /<textarea[^>]*aria-label="What the agent should do"/);
  assert.match(out, /class="cmp-check-summary"[^>]*><span class="cmp-setting-label">Check<\/span><span class="cmp-setting-value">No check<\/span>/);
  assert.doesNotMatch(out, /id="cmp-verify-heading"[^>]*aria-label=/);
  assertDomOrder(out, ['>New job</h1>', 'id="cmp-prompt"', 'id="cmp-project"', 'booking-site · main @ 8d01e4 · 212 files',
    'Uncommitted changes are not sent.', 'Also send my uncommitted changes', 'aria-label="Agent"',
    'id="cmp-verify-heading"', 'class="cmp-setting-label">Check<', 'Test command', 'Run settings',
    'Choices reflect recently reported lender settings', 'class="cmp-privacy-note"', 'aria-label="Privacy and source details"',
    FIRST_SEND_COPY.visible, 'What you’re sending',
    'Anyone lending in the circle “Weekend projects”', 'The host, Ana’s MacBook, states job/result retention is 30 days', '>Send<']);
  assert.match(out, /<p class="cmp-privacy-note">Your circle sees this prompt[^<]*<\/p>/);
  assert.doesNotMatch(out, /Your draft is saved by Faravan until you send it\./);
  assert.deepEqual([vm.send.disabled, vm.send.label, vm.send.why], [false, 'Send', '']);
  assert.doesNotMatch(out, /aria-describedby="cmp-why"/);
});

test('first-send notice is visible, names where data can go, and includes the Learn more explanation', () => {
  const out = page(vmOf(), {sendNoticeOpen:true, onConfirmFirstSend() {}, onCloseFirstSend() {}});
  const text = renderedText(out);
  assert.ok(text.includes(FIRST_SEND_COPY.visible));
  assert.ok(text.includes(FIRST_SEND_COPY.title));
  assert.ok(text.includes(FIRST_SEND_COPY.body));
  assert.ok(text.includes(FIRST_SEND_COPY.learnMore));
  assert.match(out, /<summary>Learn more<\/summary>/);
  assert.match(out, />Send job<\/button>/);
  assert.match(out, />Not now<\/button>/);
  assert.doesNotMatch(text, /Their agent sends relevant parts to its model provider/);
});

test('compose.local: choosing uncommitted changes lists them, and with none there is nothing to choose', () => {
  assert.equal(projectVM(info, {include:true}).sending, 'Also sending 2 files: src/a.js, notes.txt.');
  assert.equal(projectVM(info).sending, '');
  const clean = projectVM({...info, changed:[], changed_count:0});
  assert.deepEqual([clean.note, clean.checkbox], ['Nothing is uncommitted.', '']);
  assert.match(projectVM({...info, changed_count:12, changed:Array.from({length:12}, (_, i) => ({path:'f' + i}))}, {include:true}).sending, /f7, and 4 more\.$/);
  assert.match(renderedText(page(vmOf(), {draft:draft({includeUncommitted:true})})), /Also sending 2 files: src\/a\.js, notes\.txt\./);
});

test('compose.not-git: one message on the folder field, with its choices, and no banner above the title', () => {
  const vm = vmOf({repo:{status:'refused', refusal:{state:'compose.not-git', code:'not_git'}}}), out = page(vm, {project:null, draft:draft({path:'~/sandbox'})});
  assert.equal(vm.state, 'compose.not-git');
  assert.doesNotMatch(out, /class="banner/);
  assert.match(out, /<div class="row-meta folder-error" id="cmp-meta" role="alert">Send a folder snapshot[^<]+<\/div>/);
  assert.equal((out.match(/id="cmp-meta" role="alert"/g)||[]).length,1,'one inline failure');
  assert.match(out, /aria-describedby="cmp-meta cmp-help"/);
  assert.match(out, /aria-invalid="true"/);
  assert.doesNotMatch(out, /<code>git init<\/code>/, 'folder snapshots do not require desktop commands');
  assertDomOrder(out, ['>New job</h1>', 'id="cmp-project"', 'Send a folder snapshot', 'Choose another folder', 'Send without a project', 'class="cmp-setting-label">Check<']);
  assert.equal(vm.send.disabled, true);
});

test('compose.not-git: with No project chosen the folder message is gone and Send is allowed', () => {
  const refused = vmOf({repo:{status:'refused', refusal:{state:'compose.not-git'}}});
  assert.match(page(refused, {draft:draft({path:'~/sandbox'})}), /<button[^>]*>Send without a project<\/button>/);
  const none = vmOf({sourceKind:'none'}), after = page(none, {draft:draft({sourceKind:'none', prompt:'Make a checklist'})});
  assert.match(after, /type="radio"[^>]*value="none"[^>]*checked/);
  assert.doesNotMatch(renderedText(after), /Not a git repository|Choose another folder/);
  assert.equal(none.send.disabled, false);
});

test('compose.host-offline: the circle is unreachable, the draft stays, and Send says why', () => {
  const vm = vmOf({circle:offline}), text = renderedText(page(vm));
  assert.equal(vm.state, 'compose.host-offline');
  assert.match(text, /The circle “Weekend projects” is unreachable Can’t reach Ana’s MacBook since yesterday at 6:10 PM\. You can write a job now and send it when the circle is back\./);
  assert.match(text, /Your draft is kept on this computer\. Send is enabled again when Ana’s MacBook answers\./);
  assert.equal(vm.send.disabled, true);
  // a host that was never reached says so plainly, not "last reached undefined"
  const never = vmOf({circle:{...offline, state:{...offline.state, host:{label:'Ana’s MacBook', reachable:false}}}});
  assert.match(never.banner.text, /Ana’s MacBook hosts it and can’t be reached right now\./);
  assert.doesNotMatch(JSON.stringify(never), /undefined|null|Invalid/);
});

test('compose allows Send when an idle member answered while the owner is offline',()=>{
  const vm=vmOf({circle:{...offline,state:{...offline.state,sendReachable:true}}});
  assert.equal(vm.state,'compose.local');
  assert.equal(vm.send.disabled,false);
  assert.doesNotMatch(renderedText(page(vm)),/is unreachable|Send is enabled again/);
});

test('compose.host-offline: a total outage keeps Send disabled for the owner and a member', () => {
  for (const hosted of [true, false]) {
    const circle = {...online, state:{...online.state, hosted, networked:true,
      host:{label:'Ana’s MacBook', reachable:false, lastReachedAt:'2026-10-19T08:10:00Z'}}};
    assert.equal(circle.state.hosted,hosted);
    const vm = composeVM({prompt:draft().prompt, repo:{status:'ok',info}, circle, now:NOW, zone:'UTC'});
    assert.equal(vm.state, 'compose.host-offline');
    assert.equal(vm.send.disabled, true);
    const out=page(vm);
    if(hosted) {
      assert.match(renderedText(out), /The circle “Weekend projects” isn’t answering/);
      assert.match(renderedText(out), /Its circle server on this computer isn’t answering/);
      assert.match(renderedText(out), /Start it again from Circles → Host a circle on this computer/);
    } else assert.match(renderedText(out), /Can’t reach Ana’s MacBook since today at 8:10 AM\./);
    assert.match(out, /<button[^>]*aria-disabled="true"[^>]*>[\s\S]*?Send<\/button>/);
  }
});

test('compose.send-uncertain: one disabled button that says it is checking, the text kept, and no second Send', () => {
  const vm = vmOf({submission:'uncertain'}), out = page(vm, {draft:draft({sending:true})});
  assert.equal(vm.state, 'compose.send-uncertain');
  assert.match(renderedText(out), /Checking whether it was sent… Faravan is checking whether the job arrived\. Your draft is kept\./);
  assert.equal((out.match(/Checking whether it was sent…/g) || []).length, 2, 'the banner and the one button');
  assert.equal((out.match(/>Send</g) || []).length, 0, 'no button says Send while the answer is not in');
  assert.match(out, /<textarea[^>]*disabled/);
  assert.equal(vm.send.disabled, true);
  assert.match(vmOf({submission:'uncertain',uncertainSince:NOW-11_000}).banner.text[0], /10 seconds elapsed/);
  assert.match(vmOf({submission:'uncertain',uncertainSince:NOW-72_000}).banner.text[0], /1 minute elapsed/);
});

test('Send waits for the first thing that is missing, in one order, each with its own words', () => {
  const why = over => vmOf(over).send.why;
  assert.equal(why({prompt:'  '}), 'Send is off until you say what the agent should do.');
  assert.equal(why({repo:{status:'idle'}}), 'Send is off until you choose a project.');
  assert.equal(why({repo:{status:'checking'}}), 'Send is off while Faravan looks at the folder.');
  assert.match(why({repo:{status:'refused', refusal:{state:'compose.no-commits'}}}), /Save a first version.*folder snapshot/);
  assert.match(why({repo:{status:'refused', refusal:{state:'compose.repo-missing'}}}), /Choose an existing project folder/);
  assert.equal(why({circle:{id:'c1', name:'My devices', state:{networked:false}}}), 'Start a circle on this computer, or join with an invitation.');
  assert.equal(why({circle:{}}), 'You need an approved circle membership before sending. Open Circles to join or check your approval.');
  assert.match(why({circle:offline, prompt:''}), /^Your draft is kept on this computer/, 'the circle being away comes first: nothing the person types changes it');
  assert.deepEqual(COMPOSE_REPO_STATES.sort(), ['compose.check-failed', 'compose.no-commits', 'compose.not-git', 'compose.repo-missing', 'compose.session-lost']);
  assert.equal(composeVM({prompt:'x', repo:{status:'refused', refusal:{state:'nonsense'}}, circle:online}).state, 'compose.repo-missing', 'an unknown refusal is the generic folder problem, not blank');
});

test('the disclosure names the lenders of now, copes with none or with unnamed ones, and never shows a key', () => {
  const text = state => composeVM({prompt:'x', repo:{status:'ok', info}, circle:{id:'c1', name:'Weekend projects', state}}).disclosure;
  assert.doesNotMatch(text({networked:true, host:{label:'Ana’s MacBook', reachable:true}, lenders:[]}), /now /);
  assert.doesNotMatch(text({networked:true, host:{label:'Ana’s MacBook', reachable:true}, lenders:[{keyId:'k1'}]}), /now another member’s computer/);
  assert.match(text({networked:true, host:{reachable:true}, lenders}), /The host states job\/result retention is 30 days/);
  assert.match(composeVM({prompt:'x', repo:{status:'ok', info}, circle:{id:'c1', name:'W', state:{networked:true, host:{reachable:false}}}}).banner.text, /^The host’s computer hosts it/);
  assert.doesNotMatch(text({networked:true, host:{label:'Ana’s MacBook', reachable:true}, lenders:[{keyId:'k1'}]}), /k1/);
});

test('whenWords and dateTimeWords: today, yesterday, then the weekday and date the roster notice uses', () => {
  assert.equal(whenWords('2026-10-19T08:15:00Z', NOW, 'UTC'), 'today at 8:15 AM');
  assert.equal(whenWords('2026-10-18T18:10:00Z', NOW, 'UTC'), 'yesterday at 6:10 PM');
  assert.equal(whenWords('2026-10-15T18:10:00Z', NOW, 'UTC'), 'on Thursday 15 October at 6:10 PM');
  assert.equal(dateTimeWords('2026-10-15T18:10:00Z', 'UTC'), 'Thursday 15 October, 6:10 PM');
  assert.equal(dateTimeWords('nope', 'UTC'), '');
  assert.equal(whenWords('not a date', NOW, 'UTC'), '');
});

test('the composer has no words the vocabulary bans, and no shell command except the one design asked for', () => {
  for (const vm of [vmOf(), vmOf({circle:offline}), vmOf({submission:'uncertain'}), vmOf({repo:{status:'refused', refusal:{state:'compose.not-git'}}}), vmOf({repo:{status:'refused', refusal:{state:'compose.no-commits'}}})]) {
    assertNoBannedWords(renderedText(page(vm)));
  }
  assert.doesNotMatch(renderedText(page(vmOf())), /\bgit\b|faravan run|--/);
});

// The draft: kept on this computer, one id, rotated only when the person changes it after a refusal.
const memory = () => { const map = new Map(); return {getItem:k => map.get(k) ?? null, setItem:(k, v) => map.set(k, String(v)), removeItem:k => map.delete(k), map}; };

test('a saved draft records when its text last changed; older drafts without a time keep none', () => {
  const s = memory(), key = 'faravan-compose-draft:c1', at = () => JSON.parse(s.getItem(key)).editedAt;
  const draft = {...loadDraft(s, 'c1'), prompt:'Fix it.'};
  const before = Date.now(); saveDraft(s, 'c1', draft);
  assert.ok(at() >= before, 'a text change is stamped');
  s.setItem(key, JSON.stringify({...JSON.parse(s.getItem(key)), editedAt:1000}));
  saveDraft(s, 'c1', {...draft, path:'/home/sam/code/x'});
  assert.equal(at(), 1000, 'other changes and the mount save keep the text time');
  saveDraft(s, 'c1', {...draft, prompt:'Fix it now.'});
  assert.ok(at() >= before, 'a new text gets a new time');
  s.setItem(key, JSON.stringify({id:draft.id, prompt:'Old draft'}));
  saveDraft(s, 'c1', {...loadDraft(s, 'c1')});
  assert.equal(JSON.parse(s.getItem(key)).editedAt, undefined, 'no time is invented for an old draft');
  assert.equal(loadDraft(s, 'c1').prompt, 'Old draft');
});
test('a draft is saved per circle on this computer, comes back after a reload with its id, and is gone once sent', () => {
  const s = memory(), first = loadDraft(s, 'c1');
  assert.match(first.id, /^[A-Za-z0-9-]{8,64}$/);
  saveDraft(s, 'c1', {...first, prompt:'Fix it.', path:'/home/sam/code/x', includeUncommitted:true, verifyCmd:'npm test', verifyEdited:true, sending:true});
  const back = loadDraft(s, 'c1');
  assert.deepEqual([back.id, back.prompt, back.path, back.includeUncommitted, back.verifyCmd, back.verifyEdited, back.sending], [first.id, 'Fix it.', '/home/sam/code/x', true, 'npm test', true, true]);
  assert.equal(loadDraft(s, 'c2').prompt, '', 'another circle has its own draft');
  assert.equal(loadDraft(s, 'c2').path, '/home/sam/code/x', 'but the last folder is remembered');
  clearDraft(s, 'c1');
  assert.notEqual(loadDraft(s, 'c1').id, first.id);
  assert.equal(loadDraft(null, 'c1').prompt, '', 'no storage still works');
  s.setItem('faravan-compose-draft:c9', '{not json'); assert.equal(loadDraft(s, 'c9').prompt, '');
  s.setItem('faravan-compose-draft:c9', JSON.stringify({id:'x y', prompt:'p'})); assert.equal(loadDraft(s, 'c9').prompt, '', 'a draft with a bad id is not trusted');
  assert.notEqual(newDraftId(), newDraftId());
});

test('the request body is the same for the same draft, names the id, and only sends what was chosen', () => {
  const d = draft({prompt:'  Fix it.  ', path:' /home/sam/code/x '});
  assert.deepEqual(draftBody(d, 'c1'), {circle:'c1', prompt:'Fix it.', draft_id:'draft-0001-aaaa', repo:{path:'/home/sam/code/x'}});
  assert.deepEqual(draftBody(d, 'c1'), draftBody(d, 'c1'));
  assert.deepEqual(draftBody({...d, includeUncommitted:true, agent:'codex'}, 'c1'), {circle:'c1', prompt:'Fix it.', draft_id:'draft-0001-aaaa', repo:{path:'/home/sam/code/x', includeUncommitted:true}, harness:'codex'});
  assert.deepEqual(draftBody({...d, verifyCmd:'  npm test  '}, 'c1').verify, {cmd:'npm test'});
  assert.deepEqual(draftBody({...d, sendAnyway:true}, 'c1'), {...draftBody(d, 'c1'), send_anyway:true});
  assert.deepEqual(draftBody({...d, prompt:'Add a test.', followup:{parentJob:'parent',parentResult:'result'}, path:''},'c1'),{circle:'c1',prompt:'Add a test.',draft_id:d.id,followup:{parentJob:'parent',parentResult:'result'}});
});

test('continuation linkage survives reload and sends only the parent IDs with the delta prompt', () => {
  const s=memory(), d=draft({prompt:'Add coverage.',path:'/work/project',followup:{parentJob:'sha256:parent',parentResult:'sha256:result'},base:{path:'/work/project',branch:'review/123',commit:'a'.repeat(40)}});
  saveDraft(s,'c1',d);
  const back=loadDraft(s,'c1');
  assert.deepEqual(back.followup,d.followup);
  assert.deepEqual(back.base,d.base);
 assert.deepEqual(draftBody(back,'c1'),{circle:'c1',prompt:'Add coverage.',draft_id:d.id,followup:d.followup});
});

test('send uncertainty follows the explicit outcome, independent of status class', () => {
  assert.equal(sendUncertain({code:'network',outcome:'unknown'}), true);
  assert.equal(sendUncertain({status:500,outcome:'not_applied'}), false);
  assert.equal(sendUncertain({status:409,code:'x',outcome:'unknown'}), true);
  assert.equal(sendUncertain({status:409,code:'repo_refused',outcome:'not_applied'}), false);
  assert.equal(sendUncertain({status:400,outcome:'not_applied'}), false);
  assert.equal(sendUncertain({code:'offline',outcome:'not_applied'}), false, 'held before it left this page');
  assert.equal(sendUncertain(undefined), true);
});
test('folder errors sit under the described input and do not add a banner above the title',()=>{
  const out=page(vmOf({repo:{status:'refused',refusal:{state:'compose.repo-missing'}}}),{project:null});
  assert.match(out,/<input[^>]*aria-describedby="cmp-meta(?: cmp-help)?"/);
  assert.match(out,/<div[^>]*id="cmp-meta"[^>]*role="alert"/);
  assert.doesNotMatch(out,/class="banner/);
});

test('the composer shows and sends the test command chosen for this draft',()=>{
  const d=draft({verifyCmd:'npm test'});
  assert.deepEqual(draftBody(d,'c1').verify,{cmd:'npm test'});
  const out=page(vmOf(),{draft:d});
  assert.match(out,/id="cmp-verify"[^>]*value="npm test"/);
  assert.match(out,/class="cmp-setting-value">Command set<\/span>/);
});

test('the composer exposes all project sources without leaving the form', () => {
 const out=renderedText(page(vmOf()));for(const label of ['No project','Project folder','Git URL','Files or ZIP'])assert.ok(out.includes(label));
});

test('composer follows the checkbox and groups credential rows before source noise', () => {
  const sourceOmissions={head:[{path:'.env',reason:'credentials'}],workingTree:[
    {path:'build/cache.js',reason:'not_source'},{path:'.env',reason:'credentials'},{path:'.env.local',reason:'credentials'}]};
  const checked={...info,sendableChangedCount:0,sourceOmissions};
  assert.equal(projectVM(checked).note,'Uncommitted changes are not sent.');
  assert.equal(projectVM(checked,{include:true}).note,'None of your changed files will be sent under the current file rules.');
  const model=projectVM(checked,{include:true}).notSent;
  assert.equal(model.summary,'3 files not sent');
  assert.equal(model.credentialNote,'2 look like credentials');
  assert.deepEqual(model.files.map(f=>f.path),['.env','.env.local','build/cache.js']);
  const out=page(vmOf(),{project:checked,draft:draft({includeUncommitted:true})});
  assert.match(out,/<summary><span>3 files not sent<span class="t-2"> · 2 look like credentials<\/span><\/span><\/summary>/);
  assert.doesNotMatch(out,/<ul|<li/);
  assert.match(withoutMaskMarkers(out),/role="listitem"[^>]*class="row"/);
  assert.match(out,/<code>\.env<\/code>/);
  assert.ok(out.indexOf('<code>.env</code>')<out.indexOf('<code>build/cache.js</code>'));
  assert.match(out,/class="row-meta">looked like credentials/);
  assert.match(out,/Only filenames are checked. Check file contents yourself for passwords or keys before you send./);
  const head=page(vmOf(),{project:checked});
  assert.match(head,/1 file not sent/);assert.doesNotMatch(head,/build\/cache/);
  const noise=projectVM({...info,sourceOmissions:{head:[{path:'build/cache.js',reason:'not_source'}]}}).notSent;
  assert.equal(noise.credentialNote,'');
  assert.equal(projectVM(checked).notSent.credentialNote,'1 looks like credentials');
  assert.match(page(vmOf(),{project:{...info,sourceOmissions:{head:[],workingTree:[]}}}),/0 files not sent by filename rules/);
});


test('composer counts eligible changes beyond the truncated changed-file preview',()=>{
  const checked={...info,changed_count:300,changed:Array.from({length:200},(_,i)=>({path:'src/file'+i+'.js'})),
    sendableChangedCount:210,sourceOmissions:{head:[],workingTree:[{path:'later/.env',reason:'credentials'}]}};
  assert.match(projectVM(checked,{include:true}).sending,/Also sending 210 files:/);
});

test('a follow-up draft names the delta, shows its base, and says the current checkout stays unchanged',()=>{
 const d=draft({prompt:'',followup:{parentJob:'parent',parentResult:'result'},base:{path:'/work/project',branch:'review/123',commit:'a'.repeat(40),title:'Fix parsing'}});
 const out=page(vmOf({prompt:''}),{draft:d,circles:[online]});
 assert.match(renderedText(out),/What should change next\? Continues: Fix parsing/);
 assert.match(out,/aria-label="What should change next\?"/);
 assert.doesNotMatch(out,/a{40}/);
 assert.match(renderedText(out),/Commit a{7}/);
 assert.match(renderedText(out),/Saved source folder: \/work\/project/);
 assert.doesNotMatch(renderedText(out),/>Project<|Project folder/);
 assert.match(out,/aria-label="Circle"[^>]*disabled/);
 assert.match(renderedText(out),/A follow-up is a new job\. The lender’s saved approval mode applies\./);
});

test('a source-less continuation starts from saved result code without requiring a local folder',()=>{
 const d=draft({prompt:'Add a test.',path:'',followup:{parentJob:'parent',parentResult:'result'},base:{path:'',branch:'',commit:''}});
 const out=page(vmOf({prompt:d.prompt}),{draft:d});
 assert.match(renderedText(out),/Continues: Earlier job/);
 assert.doesNotMatch(out,/id="cmp-project"|id="cmp-folder"/);
});

test('plain folders explain the ZIP result without duplicate recovery controls',()=>{
 const plain={kind:'folder',path:'/synthetic/plain',name:'plain',files:1,changed_count:0};
 const vm=vmOf({repo:{status:'ok',info:plain}}),out=page(vm,{project:plain});
 assert.equal(vm.send.disabled,false);
 assert.match(renderedText(out),/Not a git repository.*Folder snapshot.*You can send this folder as files/);
 assert.doesNotMatch(out,/<code>git init<\/code>|Choose another folder|Send without a project/);
 assert.match(renderedText(out),/Download changed files as a ZIP/);
 assert.doesNotMatch(out,/aria-invalid="true"/);
});

test('compose.host-offline: an owner sees the circle-server recovery action',()=>{
  const ownOffline={...offline,state:{...offline.state,hosted:true}};
  const vm=vmOf({circle:ownOffline}), text=renderedText(page(vm));
  assert.match(text,/The circle “Weekend projects” isn’t answering/);
  assert.match(text,/Start it again from Circles → Host a circle on this computer/);
  assert.doesNotMatch(text,/faravan host|from the tray/i,'recovery advice names an app action, not a command');
  assert.match(text,/Send is enabled again when the circle server answers/);
  assert.doesNotMatch(vm.banner.text,/Ana’s MacBook/);
  assert.doesNotMatch(vm.send.why,/Ana’s MacBook/);
  assert.equal(vm.send.disabled,true);
});

test('F2 busy retry locks the immutable prompt, destination and source controls', () => {
  const out = page(vmOf({submission:'busy'}), {draft:draft({sending:true}),circles:[online]});
  assert.match(renderedText(out), /Waiting to send…/);
  assert.match(renderedText(out), /retry this same request.*destination are locked/);
  for (const marker of ['id="cmp-prompt"','aria-label="Circle"','aria-label="Agent"','id="cmp-folder"']) {
    const tag = out.slice(out.indexOf(marker),out.indexOf('>',out.indexOf(marker)));
    assert.match(tag,/disabled/,marker);
  }
});
test('F3 storage verifies the same draft identity and never promises failed persistence', () => {
  const values = new Map(), storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)??null};
  assert.equal(saveDraft(storage,'c1',draft()),true);
  assert.equal(loadDraft(storage,'c1').id,draft().id);
  assert.equal(saveDraft({setItem(){throw new Error('quota');},getItem(){return null;}},'c1',draft()),false);
  assert.equal(saveDraft(null,'c1',draft()),false);
  assert.equal(saveDraft({setItem(){},getItem(){return null;}},'c1',draft()),false);
  for (const submission of ['idle','uncertain']) {
    const model=vmOf({submission,draftSaved:false,circle:offline});
    assert.doesNotMatch(JSON.stringify(model),/Your draft is kept/);
  }
});
test('F7 unavailable membership and failed details give accurate next steps', () => {
  assert.match(vmOf({circle:{}}).send.why,/approved circle membership.*Open Circles/);
  const model=vmOf({circle:{...online,state:{...online.state,readStatus:'failed'}},draftSaved:false});
  assert.match(model.banner.text,/retries every 15 seconds while this page is open/);
  assert.doesNotMatch(model.banner.text,/kept|saved|host is down/);
});

for (const mode of ['quota','ignored','readback']) test('attachment replacement retains reloadable bytes when metadata fails: '+mode, async () => {
  const {readFile}=await import('node:fs/promises');
  const component=await import('./compose.jsx');
  const source=await readFile(new URL('./compose.jsx',import.meta.url),'utf8');
  // Exercise the actual production handlers, not a duplicate of their persistence decisions.
  const changeSource=source.slice(source.indexOf('  const change = '),source.indexOf('  useEffect(() => { setDraftSaved',source.indexOf('  const change = ')));
  const chooseSource=source.slice(source.indexOf('  async function chooseFiles('),source.indexOf('  const reloadCircle',source.indexOf('  async function chooseFiles(')));
  assert.ok(changeSource && chooseSource,'production handler extraction remains bound');
  const values=new Map(), blobs=new Map([['attachment-A',{files:[{name:'A'}]}]]);
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const original=draft({sourceKind:'files',attachmentId:'attachment-A',files:blobs.get('attachment-A').files});
  assert.equal(saveDraft(storage,'c1',original),true);
  let fault=true, error='';
  const broken={getItem(key) {
    if(mode==='readback' && fault && key==='faravan-compose-draft:c1')throw new Error('readback');
    return storage.getItem(key);
  },setItem(key,value) {
    if(key==='faravan-compose-draft:c1' && fault) {
      if(mode==='quota')throw new Error('quota');
      if(mode==='ignored')return;
    }
    storage.setItem(key,value);
  }};
  const draftRef={current:original};
  const dependencies={alive:{current:true},ownershipLost:{current:false},draftRef,pending:{current:null},circle:'c1',store:()=>broken,saveDraft,
    newDraftId:()=> 'attachment-B',setDraftSaved(){},setDraft:next=>{draftRef.current=next;},
    sourceEpoch:{current:0},setRepo(){},setSourceBusy(){},setSourceError:value=>{error=value;},
    readUploadSelection:async files=>({files}),saveAttachment:async(id,value)=>{blobs.set(id,value);},
    removeAttachment:async id=>{blobs.delete(id);},previewUploads:async()=>{},
    errorMessage:error=>error.message,commitAttachmentReplacement:component.commitAttachmentReplacement};
  const chooseFiles=Function(...Object.keys(dependencies),changeSource+'\n'+chooseSource+'\nreturn chooseFiles;')(...Object.values(dependencies));
  await chooseFiles([{name:'B'}]);
  assert.match(error,/couldn’t confirm your draft was saved/);
  assert.equal(draftRef.current.attachmentId,'attachment-A');
  assert.ok(blobs.has('attachment-A'));
  assert.ok(blobs.has('attachment-B'),'a successful metadata write with failed readback can still reference B');
  fault=false;
  const reloaded=loadDraft(storage,'c1');
  assert.equal(reloaded.attachmentId,mode==='readback'?'attachment-B':'attachment-A');
  assert.ok(blobs.has(reloaded.attachmentId),'reload always finds the referenced file bytes');
});
test('walk copy: leaving the composer is Back to jobs, not draft cancellation', async () => {
  const out=page(vmOf());
  assert.match(out, /<button[^>]*>Back to jobs<\/button>/);
  assert.doesNotMatch(out, /<button[^>]*>Cancel<\/button>/);
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('./compose.jsx',import.meta.url),'utf8');
  assert.match(source, /onCancel=\{\(\) => go\('jobs'\)\}/);
  const s=memory(), saved=draft();
  saveDraft(s,'c1',saved);
  assert.equal(loadDraft(s,'c1').prompt,saved.prompt);
});

test('R3 replacement retains real seeded bytes still referenced by another recovery record',async()=>{
  const {commitAttachmentReplacement}=await import('./compose.jsx');
  const bytes=new Uint8Array([82,51,45,115,101,101,100]),blobs=new Map([['attachment-A',bytes],['attachment-B',new Uint8Array([66])]]);
  const source=draft({attachmentId:'attachment-A'}),destination={...source,id:'destination-r3'};
  await commitAttachmentReplacement({previous:destination.attachmentId,selection:{files:[]},attachmentId:'attachment-B',change:()=>true,removeAttachment:async id=>blobs.delete(id)});
  assert.deepEqual(blobs.get(source.attachmentId),bytes,'another recovery record still references the exact seeded bytes');
});

async function composeSource() {
  const {readFile}=await import('node:fs/promises');
  return readFile(new URL('./compose.jsx',import.meta.url),'utf8');
}
async function changeCircleHandler(storage, saved, navigate, showError) {
  const {moveDraft}=await import('./compose-draft.mjs'), source=await composeSource();
  const handler=source.slice(source.indexOf('  const changeCircle = '),source.indexOf('  const changeJob = '));
  const deps={circle:'c1',ownershipLost:{current:false},draftRef:{current:saved},pending:{current:null},
    store:()=>storage,moveDraft,sourceEpoch:{current:0},checkerRef:{current:{cancel(){}}},
    setCircle:navigate,selected:{name:'Weekend projects'},setMoveBlocked(){},setError:showError,circlePhrase};
  return Function(...Object.keys(deps),handler+';return changeCircle;')(...Object.values(deps));
}
test('occupied_circle_draft_explains_open_instead_of_move',async()=>{
  const s=memory(),saved=draft(),other=draft({id:'other-draft-0001',prompt:'Different request'});
  saveDraft(s,'c1',saved);saveDraft(s,'c2',other);
  let destination,notice;
  const change=await changeCircleHandler(s,saved,(id,text)=>{destination=id;notice=text;},assert.fail);
  change('c2');
  assert.equal(destination,'c2');
  assert.match(renderedText(page(vmOf(),{circleNotice:notice})),/This circle already has a saved request.*We opened that request.*previous draft is still saved in the circle “Weekend projects”/);
  assert.equal(loadDraft(s,'c1').id,saved.id);assert.equal(loadDraft(s,'c2').id,other.id);
});
test('malformed_draft_has_distinct_recovery_explanation',async()=>{
  const {restoreDraft,COMPOSE_DRAFT_PREFIX}=await import('./compose-draft.mjs');
  const {DraftRestoreFailure}=await import('./compose.jsx');
  for(const raw of ['{broken',JSON.stringify({id:'bad'})]){
    const s=memory();s.setItem(COMPOSE_DRAFT_PREFIX+'c1',raw);
    const result=restoreDraft(s,'c1');assert.equal(result.state,'malformed');
    const out=renderFixture(DraftRestoreFailure,{state:result.state});
    assert.match(renderedText(out),/could not be restored.*kept unchanged on this computer\. Choose Retry, or go back to Jobs\./);
    // Retry only rereads the record (another tab may have repaired it); the words never call it a repair.
    assert.match(out,/>Retry</);assert.doesNotMatch(out,/>Export<|>Reset</);
    assert.equal(s.getItem(COMPOSE_DRAFT_PREFIX+'c1'),raw);
  }
  const result=restoreDraft({getItem(){throw Error('temporary');}},'c1');
  assert.equal(result.state,'unreadable');
  const out=renderFixture(DraftRestoreFailure,{state:result.state});
  assert.match(renderedText(out),/couldn’t open your saved draft.*Try opening it again/);assert.match(out,/>Retry</);
});
test('missing_source_draft_does_not_blame_another_tab',async()=>{
  for(const other of [null,draft({id:'replacement-0001'})]){
    const s=memory();if(other)saveDraft(s,'c1',other);let error;
    const change=await changeCircleHandler(s,draft(),assert.fail,text=>{error=text;});change('c2');
    assert.match(error,/no longer matches this page.*Copy your request before reloading/);
    assert.doesNotMatch(error,/another tab/);
  }
});
test('offline_unsent_draft_requires_explicit_send_after_reconnect',()=>{
  const vm=vmOf({clientOffline:true});
  assert.equal(vm.send.disabled,true);
  assert.match(renderedText(page(vm)),/You’re offline. Reconnect, then choose Send. This draft has not been submitted./);
  assert.equal(vmOf({clientOffline:false}).send.disabled,false);
  for(const submission of ['uncertain','busy','sending','agent-unavailable']){
    const active=vmOf({clientOffline:true,submission});
    assert.doesNotMatch(JSON.stringify(active),/has not been submitted|Reconnect, then choose Send/);
  }
});
test('compose_banner_chip_matches_checking_busy_and_unreachable_states',()=>{
  const cases=[
    [{circle:{...online,state:{...online.state,readStatus:'checking'}}},'Checking circle'],
    [{circle:{...offline,state:{...offline.state,readStatus:'failed'}}},'Circle status unavailable'],
    [{submission:'busy'},'Waiting to send'],
    [{circle:offline},'Circle unreachable'],
    [{submission:'uncertain'},'Confirming send']
  ];
  for(const [input,label] of cases){
    const vm=vmOf(input);assert.equal(vm.banner.chip,label);
    assert.ok(renderedText(page(vm)).includes(label));
    assert.doesNotMatch(renderedText(page(vm)),/Circle unavailable/);
  }
});
test('pre_send_save_failure_explains_safe_retry_without_identity_jargon',async()=>{
  const source=await composeSource();
  const handler=source.slice(source.indexOf('  async function send('),source.indexOf('  const requestSend = '));
  let error,submitted=0;
  const deps={lock:{current:false},ownershipLost:{current:false},alive:{current:true},
    submission:'idle',state:{circle:'c1',readStatus:'ready',runRequestSupported:false},repo:{},sourceKind:()=> 'none',draftRef:{current:draft({sourceKind:'none'})},
    validRequestState,signedRequestBlocker,signed:false,
    pending:{current:null},vm:{send:{disabled:false}},circle:'c1',selected:{name:'Weekend projects'},
    saveDraft:()=>false,store:()=>null,setDraftSaved(){},setError:value=>{error=value;},api:{post:()=>{submitted++;}}};
  const send=Function(...Object.keys(deps),handler+';return send;')(...Object.values(deps));
  await send();
  assert.equal(submitted,0);assert.equal(deps.pending.current,null);
  assert.match(error,/couldn’t save your draft for sending\. Nothing was sent\..*Try Send again after browser storage is available/);
  assert.doesNotMatch(error,/request identity/);
});

test('with no approved circle the reason is shown once, beside Send, with the Open Circles link', () => {
  const vm = vmOf({circle:{}}), out = page(vm, {circle:''});
  assert.equal(renderedText(out).split('You need an approved circle membership').length - 1, 1);
  assert.match(renderedText(out), /You need an approved circle membership[^]*Open Circles to join or check your approval\./);
  assert.equal(renderedText(out).split('Open Circles').length - 1, 1, 'the link text is the only Open Circles');
  assert.match(withoutMaskMarkers(out), /id="cmp-why"[^]*before sending\. <a href="#\/circles">Open Circles<\/a> to join or check your approval\.<\/p>/);
  const source = readFileSync(new URL('./compose.jsx', import.meta.url), 'utf8');
  assert.equal(source.split('approved circle membership').length - 1, 0, 'the page banner that repeated the reason is gone');
});

test('a folder refusal opens Project so its message and recovery buttons are visible', () => {
  const vm = vmOf({repo:{status:'refused', refusal:{state:'compose.repo-missing'}}}), out = page(vm, {project:null});
  assert.match(out, /<details[^>]*id="cmp-project"[^>]*\sopen/);
  assert.match(out, /id="cmp-meta"[^>]*role="alert"/);
  assert.doesNotMatch(page(vmOf(), {}), /<details[^>]*id="cmp-project"[^>]*\sopen/, 'a healthy project stays closed');
  const noProject = page(vm, {project:null, draft:draft({sourceKind:'none'})});
  assert.doesNotMatch(noProject, /<details[^>]*id="cmp-project"[^>]*\sopen/, 'a stale folder refusal does not open Project when sending without one');
});

test('Model and Effort edits after an agent refusal take the same new-draft transition as Agent edits', () => {
  const source = readFileSync(new URL('./compose.jsx', import.meta.url), 'utf8');
  assert.match(source, /onModel=\{\(value\) => \{[^\n]*\{auto: '', model: value\}[^\n]*agentRefusal \? editRefusedJob\(pick\(patch\)\)/);
  assert.match(source, /onEffort=\{\(effort\) => agentRefusal \? editRefusedJob\(\{effort\}\)/);
});

test('initial composer circles failure is recoverable instead of an endless skeleton', () => {
 const props={circles:[],data:{},api:{},refresh(){},setCircle(){}};
 const pending=renderFixture(Compose,props);
 assert.match(pending,/aria-label="Loading the composer"/);
 const failed=renderFixture(Compose,{...props,errors:{circles:{code:'network'}}});
 assert.match(renderedText(failed),/Circles could not be loaded/);
 assert.match(renderedText(failed),/Your saved request has not changed/);
 assert.match(renderedText(failed),/Retry circles/);
 assert.match(failed,/href="#\/jobs"/);
 assert.match(failed,/href="#\/circles"/);
 assert.doesNotMatch(failed,/aria-label="Loading the composer"/);
 const source=readFileSync(new URL('./compose.jsx',import.meta.url),'utf8');
 assert.match(source,/onClick=\{\(\)=>refresh\(\)\}>Retry circles/);
});

test('copy audit B explains commit pinning and model effort without promising content checks',()=>{
 const out=page(vmOf(),{draft:draft({sourceKind:'git',agent:'codex',model:'example-model'}),offers:[]});
 const text=renderedText(out);
 assert.match(text,/linked repository at the selected commit/);
 assert.match(text,/has not checked its files, which files are left out, or their contents/);
 assert.match(text,/Choosing a model means you also choose the effort/);
});

test('Model and Effort explain absent agents and absent lender choices visibly', () => {
  for (const [selected, reason] of [['','Choose an agent first.'],['codex','No lender offers a choice right now.']]) {
    const out=page(vmOf(),{draft:draft({agent:selected}),offers:[]});
    for (const name of ['model','effort']) {
      const tag=out.match(new RegExp('<select[^>]*id="cmp-'+name+'"[^>]*>'))?.[0];
      assert.ok(tag,name);
      assert.match(tag,/disabled/);
      const ids=tag.match(/aria-describedby="([^"]+)"/)?.[1].split(' ') || [];
      assert.ok(ids.some(id=>out.includes('id="'+id+'">'+reason+'</span>')),name+' has a visible linked reason');
      if(name==='effort')assert.ok(ids.includes('cmp-effort-help'),'retain cost description');
    }
  }

  // A stale saved choice must still be clearable to the explicit default.
  const out=page(vmOf(),{draft:draft({agent:'codex',model:'previous-model',effort:'high'}),offers:[]});
  for(const name of ['model','effort']){
    const tag=out.match(new RegExp('<select[^>]*id="cmp-'+name+'"[^>]*>'))?.[0];
    assert.ok(tag);assert.doesNotMatch(tag,/disabled/);
  }
  // Preact serializes an empty value as a bare `value` attribute.
  assert.match(out,/<option value(="")?>Let the lender choose<\/option>/);
});
