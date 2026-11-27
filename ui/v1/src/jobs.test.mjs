import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Jobs, JobsList, WaitingJob, jobPageRecord, createdJobPageSeed, clearCreatedJobPageSeed, jobLastOutputAt} from './jobs.jsx';
import {Palette, paletteKeyAction} from './palette.jsx';
import {jobsListVM, jobVM, jobAvatarVM} from './view-models.mjs';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';

// U14 render tests: the Jobs list, its empty and loading states, and the palette. No browser.
const T = Date.parse('2026-10-19T15:00:00Z');
const jobs = [
  {job_digest:'sha256:a', role:'sent', status:'Finished', receipt:{harness:'codex'}, local:{title:'Fix the flaky date test', agent:'codex', submittedAt:new Date(T - 720000).toISOString()}, lenderName:'Mo', circle:{id:'c1'}},
  {job_digest:'sha256:e', role:'ran', status:'Failed', historyIdentity:{localName:'Sam'}, waitingTiming:{submittedAt:new Date(T - 27 * 3600000).toISOString()}, circle:{id:'c1'}, title:'Sam’s job'},
];
const vm = (filter = 'all') => jobsListVM(jobs, {now:T, machine:'Ana’s MacBook', filter});

test('a queued job names its saved lender and explains Stop then send again',()=>{
  const job={job_digest:'waiting',state:'queued',waitingHome:'Mo’s laptop'};
  const text=renderedText(renderFixture(WaitingJob,{job}));
  assert.match(text,/Waiting for Mo’s laptop/);
  assert.match(text,/This job waits for that computer\. Choose Stop, then send again/);
  assert.doesNotMatch(text,/Another computer|A lender’s computer takes it/);
});

test('no-lender rows preserve current versus last-known wording in list and palette', async () => {
  const {adaptLegacyJob, qualifyJobProjection} = await import('../../../lib/v1/state-projection.mjs');
  const {paletteVM} = await import('./view-models.mjs');
  const job = {job_digest:'waiting',state:'queued',role:'sent',waiting_reason:'agent_unavailable',circle:{id:'c1'},local:{title:'Waiting task'}};
  const projection = adaptLegacyJob(job,{observedAt:'2026-10-19T15:00:00Z'});
  for (const [observation,expected] of [['current','Waiting · no lender'],['last_known','Last known: Waiting · no lender']]) {
    const value = {...job,jobProjection:qualifyJobProjection(projection,{state:observation,at:'2026-10-19T15:00:00Z'})};
    const rows = jobsListVM([value],{now:T}).groups.flatMap(g=>g.rows);
    assert.equal(rows[0].word,expected);
    assert.ok(paletteVM('Waiting task',{jobs:rows}).items[0].label.endsWith(expected.toLowerCase()));
  }
});

test('palette identities and labels distinguish the same digest in different circles after reordering', async () => {
  const {paletteVM} = await import('./view-models.mjs');
  const rows = jobsListVM(['Blue','Green'].map(name=>({...jobs[0],circle:{id:name.toLowerCase(),name}})),{now:T}).groups.flatMap(g=>g.rows);
  const items = paletteVM('flaky',{jobs:rows}).items;
  assert.equal(new Set(items.map(item=>item.id)).size,2);
  assert.match(items[0].label,/Blue/);
  assert.match(items[1].label,/Green/);
  const targets = new Map(items.map(item=>[item.id,item.href]));
  const reordered = paletteVM('date',{jobs:[...rows].reverse()}).items.filter(item=>item.id.startsWith('job:'));
  assert.equal(reordered.length,2);
  for (const item of reordered) assert.equal(item.href,targets.get(item.id));
  assert.equal(items[0].href,'#/job/sha256%3Aa/blue');
  assert.equal(items[1].href,'#/job/sha256%3Aa/green');
});

test('J/K includes collapsed batch summaries without including their hidden child links', async () => {
  const {readFile} = await import('node:fs/promises');
  const source = await readFile(new URL('./jobs.jsx',import.meta.url),'utf8');
  assert.match(source,/querySelectorAll\('\.jlist a\.row, \.jobs-batch > summary'\)/);
  assert.match(source,/row\.tagName === 'SUMMARY' \|\| !row\.closest\('details:not\(\[open\]\)'\)/);
});


test('accepted incoming work is visible without past-tense execution or sent-job attribution', () => {
  const accepted = {job_digest:'sha256:accepted',role:'received',state:'starting',approval:'approved',status:'Starting',
    historyIdentity:{localName:'Sam'},title:'Fix the dates',circle:{id:'c1'},created_at:new Date(T).toISOString()};
  const model = jobsListVM([accepted],{now:T,machine:'Ana’s MacBook'});
  const row = model.groups.flatMap(group => group.rows)[0];
  assert.equal(row.role,'received');
  assert.equal(row.word,'Preparing');
  assert.equal(row.title,'Fix the dates');
  assert.match(row.who,/for Sam/);
  assert.doesNotMatch(row.who,/ran for/);
  assert.equal(row.href,'#/job/sha256%3Aaccepted/c1');
  assert.equal(jobsListVM([accepted],{now:T,filter:'sent'}).count,0);
  assert.equal(jobsListVM([accepted],{now:T,filter:'ran'}).count,1);
  assert.equal(model.filters.find(filter=>filter.id==='ran').count,1);
  const text = renderedText(renderFixture(JobsList,{vm:model,onFilter() {}}));
  assert.match(text,/Fix the dates.*Preparing/);
  assert.doesNotMatch(text,/You ran|ran for Sam|jobs you ran/);
  assert.equal(jobVM({...accepted,title:undefined}).title,'Job for Sam');
  assert.equal(jobVM({...accepted,title:undefined,historyIdentity:{}}).title,'A job accepted here');
  assert.doesNotMatch(jobVM(accepted).receiptTitle,/You ran/);
});

test('the global jobs list cannot seed a job page before its detail record loads', () => {
  const stale = {job_digest:'sha256:a', state:'queued', role:'sent'};
  assert.equal(jobPageRecord({record:null, listed:stale, created:null}), null);
  assert.deepEqual(jobPageRecord({record:{job_digest:'sha256:a', state:'result-accepted'}, listed:stale, created:null}),
    {...stale, job_digest:'sha256:a', state:'result-accepted'});
  assert.equal(jobPageRecord({record:null, listed:{...stale, state:'result-accepted'}, created:null}), null);
});

const createdSeed = {job_digest:'sha256:new-job', circle:{id:'circle'}, title:'Fix the dates', prompt:'Fix the dates', submittedByMe:true};

test('an explicitly incomplete detail keeps only its matched submission acknowledgement as transitional',async()=>{
  const {createJobProjection}=await import('../../../lib/v1/state-projection.mjs');
  const {jobProjectionFor}=await import('./job-projection-view.mjs');
  const created=createdJobPageSeed({seed:createdSeed,navigationType:'navigate',id:createdSeed.job_digest,circle:'circle'});
  const record={job_digest:createdSeed.job_digest,circle:{id:'circle'},state:'claimed',current_attempt:{attempt_id:'new-attempt',generation:1},
    jobProjection:createJobProjection({schemaVersion:2,kind:'job',phase:'unknown',reasonCode:'observation_changed',
      result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},evidence:{observation:'incomplete'},
      version:{jobDigest:createdSeed.job_digest,attemptId:'new-attempt',generation:1},
      times:{observedAt:'2026-10-26T08:00:00Z',validUntil:null,nextTransitionAt:null},actionHints:[]})};
  const shown=jobPageRecord({record,listed:null,created});
  const projection=jobProjectionFor(shown);
  assert.equal(projection.phase,'waiting','incomplete200 erased the confirmed submission');
  assert.equal(projection.observation?.state,'transitional');
  assert.deepEqual(projection.actionHints,[]);
  assert.notEqual(jobVM(shown,'sent').word,'Status unavailable');
});
test('unknown projection from the global list cannot contaminate valid legacy detail',async()=>{
  const {createJobProjection}=await import('../../../lib/v1/state-projection.mjs');
  const {jobProjectionFor}=await import('./job-projection-view.mjs');
  const record={job_digest:'sha256:a',circle:{id:'c1'},state:'claimed',current_attempt:{attempt_id:'a1',generation:2,execution_started_at:'2026-10-26T08:00:00Z'}};
  const listed={job_digest:'sha256:a',circle:{id:'c1'},jobProjection:createJobProjection(null),local:{title:'Known title'}};
  const shown=jobPageRecord({record,listed,created:null});
  assert.equal(jobProjectionFor(shown).phase,'running');
  assert.equal(shown.local.title,'Known title');
});

test('a persisted createdJob does not become live status after reload or back navigation', () => {
  for (const navigationType of ['reload','back_forward']) {
    assert.equal(createdJobPageSeed({seed:createdSeed,navigationType,id:createdSeed.job_digest,circle:'circle'}), null);
  }
});

test('a failed detail read discards the optimistic createdJob state', () => {
  const created = createdJobPageSeed({seed:createdSeed,navigationType:'navigate',id:createdSeed.job_digest,circle:'circle'});
  assert.ok(created, 'the in-app submission can seed its first paint');
  assert.equal(jobPageRecord({record:null,listed:null,created,error:new Error('offline')}), null);
});

test('the createdJob history seed is cleared when the authoritative detail record arrives', () => {
  const history = {state:{createdJob:createdSeed,other:'keep'},replaceState(state) { this.state = state; }};
  assert.equal(clearCreatedJobPageSeed(history, createdSeed.job_digest), true);
  assert.deepEqual(history.state, {other:'keep'});
});


test('incomplete fallback keeps the latest matched view and never masks conflicts, refusal or other identities',async()=>{
  const {createJobProjection,adaptLegacyJob}=await import('../../../lib/v1/state-projection.mjs');
  const {jobProjectionFor}=await import('./job-projection-view.mjs');
  const {jobStatusVM}=await import('./view-models.mjs');
  const created=createdJobPageSeed({seed:createdSeed,navigationType:'navigate',id:createdSeed.job_digest,circle:'circle'});
  const running={job_digest:createdSeed.job_digest,circle:{id:'circle'},state:'claimed',
    current_attempt:{attempt_id:'started-attempt',generation:2,execution_started_at:'2026-10-26T08:00:00Z'}};
  running.jobProjection=adaptLegacyJob(running,{observedAt:'2026-10-26T08:00:01Z'});
  const incomplete={job_digest:createdSeed.job_digest,circle:{id:'circle'},state:'claimed',
    jobProjection:createJobProjection({schemaVersion:2,kind:'job',phase:'unknown',reasonCode:'observation_unavailable',
      result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},evidence:{observation:'incomplete'},
      version:{jobDigest:createdSeed.job_digest,attemptId:'newer-unconfirmed',generation:3},
      times:{observedAt:'2026-10-26T08:00:02Z',validUntil:null,nextTransitionAt:null},actionHints:[]})};
  const shown=jobPageRecord({record:incomplete,previous:running,created});
  const projection=jobProjectionFor(shown);
  assert.equal(projection.phase,'running','never regress to the initial created seed');
  assert.equal(projection.version.attemptId,'started-attempt');
  assert.equal(shown.current_attempt.attempt_id,projection.version.attemptId);
  assert.equal(projection.observation.state,'last_known');
  assert.deepEqual(projection.actionHints,[]);
  assert.equal(jobStatusVM(shown).canStop,false);
  assert.match(jobsListVM([{...shown,role:'sent'}],{now:T}).groups.flatMap(g=>g.rows)[0].word,/Last known:/);
  assert.equal(jobProjectionFor(jobPageRecord({record:running,previous:created,created})).phase,'running','current valid detail wins');
  for(const record of [
    {...incomplete,circle:{id:'other-circle'}},
    {...incomplete,job_digest:'another-job'},
    {...incomplete,jobProjection:{...incomplete.jobProjection,version:{jobDigest:'another-job'}}},
    {...incomplete,jobProjection:{...incomplete.jobProjection,reasonCode:'contradictory_evidence'}},
    {...incomplete,jobProjection:{...incomplete.jobProjection,phase:'invented'}},
    {...incomplete,jobProjection:{...incomplete.jobProjection,evidence:{}}},
  ]) assert.equal(jobProjectionFor(jobPageRecord({record,previous:running,created})).phase,'unknown');
  for(const error of [{status:403},{status:404},new Error('offline')]) {
    assert.equal(jobProjectionFor(jobPageRecord({record:incomplete,previous:running,created,error})).phase,'unknown');
    assert.equal(jobPageRecord({record:null,previous:running,created,error}),null);
  }
  assert.equal(jobProjectionFor(jobPageRecord({record:incomplete,listed:running,created:null})).phase,'unknown','list is not confirmed page evidence');
  assert.equal(jobProjectionFor(jobPageRecord({record:incomplete,previous:{...running,current_attempt:{...running.current_attempt,generation:99}},created})).phase,'unknown','mismatched prior attempt evidence cannot recover');
});

test('silence timing requires an output timestamp from a live transcript stream', () => {
  const observedAt = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(jobLastOutputAt(null, {lastAt:observedAt}), null, 'an unavailable transcript is not silence evidence');
  assert.equal(jobLastOutputAt({text:'',live:false}, {lastAt:null}), null, 'an empty non-live transcript has no output timestamp');
  assert.equal(jobLastOutputAt({text:'old transcript',live:false}, {lastAt:observedAt}), null, 'a non-live stream cannot support a current quiet claim');
  assert.equal(jobLastOutputAt({text:'observed',live:true}, {lastAt:observedAt}), observedAt);
  assert.equal(jobLastOutputAt({text:'',live:true}, {lastAt:null}), null, 'an empty live stream still has no output timestamp');
});

test('the list: filters, then groups in order, each row a link with status, who and when', () => {
  const out = renderFixture(JobsList, {vm:vm(), onFilter() {}});
  assertDomOrder(out, ['aria-label="Show"', 'aria-label="Today"', '>Fix the flaky date test</span>', 'aria-label="Yesterday"', '>Sam’s job</span>']);
  assert.match(out, /href="#\/job\/sha256%3Aa\/c1"/);
  assert.match(renderedText(out), /Ready to review Codex 12 min ago/);
  assert.equal((out.match(/aria-pressed="true"/g) || []).length, 1, 'one filter is on');
  assert.match(out, /<button[^>]*class="chip on"[^>]*aria-pressed="true"[^>]*>All <span[^>]*>2</);
  assertNoBannedWords(out);
});

test('job attention exists only with a named job and an action', () => {
  const empty = jobsListVM([], {now:T});
  assert.equal(empty.filters.some(f => f.id === 'needs'), false);
  const ready = {...jobs[0], format:'message'};
  const model = jobsListVM([ready], {now:T, filter:'needs'});
  assert.equal(model.filters.find(f => f.id === 'needs')?.count, 1);
  const result = renderFixture(JobsList, {vm:model, onFilter() {}});
  assert.match(renderedText(result), /Fix the flaky date test\s+Review result/);
  assert.match(result, /href="#\/job\/sha256%3Aa\/c1"/);
  const approval = jobsListVM([jobs[1]], {now:T, filter:'needs', jobApprovals:[{id:'approval-a',jobDigest:jobs[1].job_digest}]});
  const request = renderFixture(JobsList, {vm:approval, onFilter() {}});
  assert.match(request, /href="#\/request\/approval-a"/);
  assert.match(renderedText(request), /Review request/);
});

test('a filter with no rows says so', () => {
  assert.match(renderedText(renderFixture(JobsList, {vm:jobsListVM([], {now:T, filter:'needs'}), onFilter() {}})), /No jobs match your search or filters.*Clear filters/);
});

test('before the jobs load there is a skeleton, not a blank page', () => {
  const out = renderFixture(Jobs, {api:{}, circles:[{id:'c1', origin:'http://x'}], selected:{id:'c1', origin:'http://x'}, revision:0, data:{}, devices:{}});
  assert.match(out, /role="status" aria-label="Loading jobs"/);
  assert.equal((out.match(/class="skel"/g) || []).length >= 3, true);
});

test('with no connected circle the empty state says what to do first', () => {
  const out = renderFixture(Jobs, {api:{}, circles:[], selected:{id:'x', origin:null}, revision:0, data:{}, devices:{}});
  assert.match(renderedText(out), /Run your first job Start a circle or join with an invitation to send your first job\./);
});

const palette = (props = {}) => renderFixture(Palette, {api:{}, open:true, onClose() {}, circles:[], data:{approvals:[]}, lending:{enabled:true}, devices:{}, revision:0, run() {}, ...props});

test('the palette is a dialog with a labelled search field, sections, shortcuts and Esc', () => {
  const out = palette();
  assert.match(out, /<dialog[^>]*role="dialog" aria-modal="true" aria-label="Search"/);
  assert.match(out, /↑↓ to move · ↵ to open · esc/);
  assert.match(out, /aria-label="Go to"/);
  assert.match(out, /aria-label="Keyboard shortcuts"/);
  assert.match(out, /<input[^>]*role="combobox"/);
  assert.match(out, /<input[^>]*aria-label="Search or jump to"/);
  assertDomOrder(out, ['aria-label="Actions"', '>New job<', '>Pause lending<']);
  assert.match(out, /<span class="kbd" aria-hidden="true">N<\/span>/);
  assert.match(out, /<span class="kbd" aria-hidden="true">⇧P<\/span>/);
  assert.match(out, /aria-selected="true"/);
});

test('a closed palette renders nothing', () => {
  assert.equal(palette({open:false}), '');
});

// Review P1: Tab moved focus to an option without selecting it, so Enter opened a different item,
// and nothing held focus inside the dialog.
test('palette options are never in the tab order, so focus and selection cannot disagree', () => {
  const out = palette();
  const options = out.match(/<button[^>]*role="option"[^>]*>/g);
  assert.ok(options.length >= 2);
  for (const tag of options) assert.match(tag, /tabindex="-1"/, tag);
});

test('palette keys: Tab stays in the dialog, arrows move the one selection, Enter opens it', () => {
  assert.deepEqual(paletteKeyAction('Tab', {at: 1, count: 4}), {at: 1, preventDefault: true});
  assert.deepEqual(paletteKeyAction('ArrowDown', {at: 1, count: 4}), {at: 2, preventDefault: true});
  assert.equal(paletteKeyAction('ArrowDown', {at: 3, count: 4}).at, 3, 'no wrap past the end');
  assert.equal(paletteKeyAction('ArrowUp', {at: 0, count: 4}).at, 0);
  assert.deepEqual(paletteKeyAction('Enter', {at: 2, count: 4}), {choose: true, at: 2, preventDefault: true});
  assert.equal(paletteKeyAction('Enter', {at: 0, count: 0}).choose, false, 'nothing to open');
  assert.deepEqual(paletteKeyAction('Escape', {at: 2, count: 4}), {close: true, preventDefault: true, at: 2});
});

test('Enter clamps selection when a query or refresh shrinks the result list', () => {
  assert.deepEqual(paletteKeyAction('Enter',{at:8,count:2}),{choose:true,at:1,preventDefault:true});
});


const rowsOf = vm => vm.groups.flatMap(g => g.rows);
test('sort precedes local calendar grouping; missing dates stay last and lender timestamps use run facts', () => {
  const now = Date.parse('2026-10-23T20:00:00Z');
  const make = (id, submittedAt) => ({job_digest:id,role:'sent',state:'queued',local:{title:id,submittedAt}});
  const rows = [make('old','2026-10-10T20:00:00Z'),make('unknown','invalid'),make('week','2026-10-20T20:00:00Z'),make('today','2026-10-23T19:00:00Z'),make('yesterday','2026-10-22T19:00:00Z'),{job_digest:'lender',role:'ran',state:'result-accepted',historyIdentity:{localName:'Sam'},current_attempt:{execution_started_at:'2026-10-23T18:00:00Z'}}];
  const vm = jobsListVM(rows,{now,computerZone:'America/Chicago'});
  assert.deepEqual(vm.groups.map(g => g.title),['Today','Yesterday','Earlier this week','Earlier']);
  assert.deepEqual(rowsOf(vm).map(r => r.id),['today','lender','yesterday','week','old','unknown']);
  assert.equal(rowsOf(vm).at(-1).when,'Time unavailable');
  assert.equal(rowsOf(vm)[1].when,'2 h ago');
  assert.equal(rowsOf(vm)[1].word,'Sent back');
});

test('calendar groups handle daylight saving time and the computer zone', () => {
  const now = Date.parse('2026-11-02T05:30:00Z'); // Sunday, 11:30 PM in Chicago after the clock changed.
  const vm=jobsListVM([{job_digest:'y',role:'sent',local:{submittedAt:'2026-11-01T04:30:00Z'}},{job_digest:'t',role:'sent',local:{submittedAt:'2026-11-01T06:30:00Z'}}],{now,computerZone:'America/Chicago'});
  assert.deepEqual(vm.groups.map(g => g.title),['Today','Yesterday']);
});

test('counts ignore search and filter; search includes the person, title, agent and status', () => {
  const vm=jobsListVM(jobs,{now:T,filter:'sent',query:'date'});
  assert.equal(vm.count,1);
  assert.deepEqual(vm.filters.map(f=>[f.label,f.count]),[['All',2],['Sent by me',1],['Ran for others',1]]);
  assert.equal(jobsListVM(jobs,{now:T,query:'sam'}).count,1);
  assert.equal(jobsListVM(jobs,{now:T,query:'CODEx'}).count,1);
  assert.equal(jobsListVM(jobs,{now:T,query:'no match'}).count,0);
});

test('only runs of more than two lender rows on the same day collapse and remain keyboard links', () => {
  const ran = n => ({job_digest:'ran'+n,role:'ran',state:'result-accepted',historyIdentity:{localName:'Sam'},created_at:new Date(T-n*60000).toISOString()});
  const vm=jobsListVM([ran(1),ran(2),ran(3),ran(4)],{now:T});
  assert.equal(vm.count,4); assert.equal(vm.groups[0].items.length,1);
  assert.equal(vm.groups[0].items[0].label,'4 jobs you ran for others today');
  const out=renderFixture(JobsList,{vm,onFilter(){}});
  assert.match(out,/<details class="jobs-batch"><summary>/);
  assert.equal((withoutMaskMarkers(out).match(/class="row" href=/g)||[]).length,4);
  assert.match(out,/<use href="#stack"/);
  assert.equal(jobsListVM([ran(1),ran(2)],{now:T}).groups[0].items.length,2);
  assert.equal(jobsListVM([ran(1),ran(2),{...ran(3),created_at:new Date(T-86400000).toISOString()}],{now:T}).groups[0].items.length,2);
});

test('one job identity feeds title and context-specific status, with aligned kind glyphs', () => {
  const device={job_digest:'device',role:'ran',state:'result-accepted',historyIdentity:{deviceName:'faravan-borrower'},created_at:new Date(T).toISOString()};
  assert.equal(jobAvatarVM(jobs[0]),null);
  assert.deepEqual(jobAvatarVM(device),{kind:'device'});
  assert.equal(jobAvatarVM(jobs[1]).kind,'person');
  const vm=jobsListVM([jobs[0],device],{now:T});
  for(const job of [jobs[0],device]) {
    const row=rowsOf(vm).find(r=>r.id===job.job_digest), identity=jobVM(job,job.role,{lender:job.lenderName,now:T});
    assert.equal(row.title,identity.title);assert.equal(row.word,identity.listWord);
  }
  const out=renderFixture(JobsList,{vm,onFilter(){}});
  assert.match(out,/<use href="#laptop"/);
  assert.match(out,/<use href="#arrow-up-right"/);
  assert.equal(rowsOf(vm).find(r=>r.id==='device').word,'Sent back');
  assert.equal(jobVM(device,'ran').word,'Sent back');
  assert.doesNotMatch(out,/class="av/);
  assert.match(out,/title="Fix the flaky date test"/);
  assert.match(out,/aria-label="Search jobs"/);
  assertDomOrder(out,['>Status<','>Agent<','>Updated<']);
});


test('shared status keeps lender running, stopped and unconfirmed stops consistent', () => {
  const now=Date.parse('2026-10-20T04:00:00Z');
  const stopUnconfirmed={schemaVersion:2,kind:'job',phase:'stopping',reasonCode:'stop_unconfirmed',
    result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
    evidence:{rawState:'stop-requested',attemptPresent:true,approval:'approved',approvedAt:'2026-10-20T03:54:00Z',executionStartedAt:'2026-10-20T03:30:00Z',computeStopped:false,stopVerification:'failed'},
    version:{},times:{observedAt:'2026-10-20T04:00:00Z',validUntil:null,nextTransitionAt:null},actionHints:[]};
  const cases=[
    [{state:'running',current_attempt:{execution_started_at:'2026-10-20T03:54:00Z'}},'Running'],
    [{state:'cancelled',compute_stopped:true,current_attempt:{execution_started_at:'2026-10-20T03:30:00Z'}},'Stopped'],
    [{jobProjection:stopUnconfirmed},'Stop not confirmed']
  ];
  for(const [fields,expected] of cases) {
    const job={job_digest:'j',role:'ran',historyIdentity:{localName:'Sam'},...fields};
    assert.equal(jobVM(job,'ran',{now}).word,expected);
    assert.equal(rowsOf(jobsListVM([job],{now}))[0].word,expected);
  }
});


test('a job row keeps the circle beside its title', () => {
 const vm=jobsListVM([{...jobs[0],circle:{id:'friends',name:'Weekend projects'}}],{now:T});
 const out=renderFixture(JobsList,{vm,onFilter(){}});
 assert.match(out,/<span class="job-circle" title="Weekend projects">Weekend projects<\/span>/);
});

 test('requester names provide a fallback title only when the job has no accepted title', () => {
 for (const [historyIdentity,title] of [[{localName:'Sam',deviceName:'Laptop'},'Job for Sam'],[{deviceName:'faravan-borrower'},'Job for faravan-borrower'],[{},'A job you ran']]) {
 const job={job_digest:'identity',role:'ran',state:'result-accepted',historyIdentity};
 const row=rowsOf(jobsListVM([job],{now:T}))[0];
 assert.equal(row.title,title);assert.equal(row.title,jobVM(job).title);assert.equal(row.word,'Sent back');assert.equal(row.glyph,'laptop');
 }
 });

test('waiting reason renders the backend headline and desktop and phone list tooltips', () => {
  const message = 'No computer in Faravan test lends Claude Code right now';
  const job = {job_digest:'waiting', state:'queued', status:'Waiting', role:'sent',
    waiting_reason:'agent_unavailable', waiting_message:message, message:'Unrelated submit refusal',
    waitingTiming:{submittedAt:'2026-10-19T19:41:00Z', expiresAt:'2026-10-20T19:41:00Z'}};
  const out = renderFixture(WaitingJob, {job, circleLabel:'Faravan test'});
  assert.match(out, new RegExp('<b>' + message + '</b>'));
  assert.match(renderedText(out), /Sent to Faravan test at .* A lender’s computer takes it when it is free and has time left today\. Expires .* if nobody takes it\./);
  assert.doesNotMatch(out, /Waiting for a computer/);
  const list = value => renderFixture(JobsList, {vm:jobsListVM([value], {now:T}), onFilter() {}});
  const rendered = list(job);
  assert.match(rendered, /row-meta phone-only dots"><span class="st wait" title="No computer in Faravan test lends Claude Code right now">Waiting · no lender<\/span>/);
  assert.match(rendered, /class="jcol job-status t-sm" title="No computer in Faravan test lends Claude Code right now"><span class="st wait">Waiting · no lender<\/span>/);
  const {waiting_reason, waiting_message:ignored, ...control} = job;
  assert.equal(list({...control, waiting_message:message}), list(control), 'unrelated message changes nothing');
  assert.equal(renderFixture(WaitingJob, {job:{...control, waiting_message:message}}), renderFixture(WaitingJob, {job:control}));
  for (const blank of ['', '  ']) {
    assert.match(renderFixture(WaitingJob, {job:{...job, waiting_message:blank}}), /<b>Waiting for a computer<\/b>/);
  }
  for (const state of ['running', 'finished', 'failed', 'expired', 'cancelled']) {
    assert.equal(list({...job, state, status:state}), list({...control, state, status:state}), state);
  }
});

import * as jobComponents from './jobs.jsx';
import {readFile} from 'node:fs/promises';

test('a terminal transcript error shows recovery instead of loading', () => {
  const transcript={data:null,error:new Error('offline')};let retries=0;
  const props={transcript,onRetry:()=>{retries++;}};
  const out=renderFixture(jobComponents.JobSummaryStatus,props);
  assert.match(renderedText(out),/Check the current state/);
  assert.doesNotMatch(renderedText(out),/Loading/);
  assert.match(out,/role="alert"/);
  assert.match(renderedText(out),/Check current state/);
  const empty=renderFixture(jobComponents.JobSummaryStatus,{transcript:{data:{text:'',live:false},error:null},onRetry(){}});
  assert.match(renderedText(empty),/No final message was recorded/);
  assert.doesNotMatch(renderedText(empty),/Loading|Retry/);
});

test('terminal transcript Retry uses the same single-flight resource reader', async () => {
  const source=await readFile(new URL('./jobs.jsx',import.meta.url),'utf8');
  assert.match(source,/<JobSummaryStatus[^>]*onRetry=\{transcript\.reload\}/);
  assert.doesNotMatch(source,/setActivityTick|setTranscriptRetry/);
});

// Judge r9 O-C: with the host offline, a saved job row keeps the status it was saved with, framed as last known,
// never "Status unavailable".
test('a saved job row reads its last known status, not "Status unavailable"', async () => {
  const {jobsListVM} = await import('./view-models.mjs');
  const {adaptLegacyJob, qualifyJobProjection} = await import('../../../lib/v1/state-projection.mjs');
  const view = {job_digest:'sha256:'+'c'.repeat(64), state:'result-accepted', result_digest:'sha256:'+'d'.repeat(64), current_attempt:null, role:'sent', circle:{id:'c1',name:'Weekend projects'}};
  const saved = {...view, savedAt:'2026-10-22T09:00:00.000Z',
    jobProjection:qualifyJobProjection(adaptLegacyJob(view,{observedAt:'2026-10-22T09:00:00.000Z'}),{state:'last_known',at:'2026-10-22T09:00:00.000Z'})};
  const [row] = jobsListVM([saved], {now:Date.parse('2026-10-22T09:05:00.000Z')}).groups.flatMap(g => g.rows);
  assert.equal(row.word, 'Last known: Ready to review');
  assert.doesNotMatch(JSON.stringify(row), /Status unavailable/);
});


test('incomplete fallback does not inherit completed-result mutation eligibility',async()=>{
  const {createJobProjection}=await import('../../../lib/v1/state-projection.mjs');
  const {jobProjectionFor}=await import('./job-projection-view.mjs');
  const {jobDetailVM}=await import('./view-models.mjs');
  const digest='sha256:finished',at='2026-10-26T08:00:00Z';
  const previous={job_digest:digest,circle:{id:'circle'},state:'result-accepted',canSetBorrowerOutcome:true,
    current_attempt:{attempt_id:'a2',generation:2},
    jobProjection:createJobProjection({schemaVersion:2,kind:'job',phase:'result_accepted',reasonCode:null,
      result:{available:true,digest:'sha256:result'},application:{outcome:null,appliedBranch:null},evidence:{rawState:'result-accepted'},
      version:{jobDigest:digest,attemptId:'a2',generation:2},times:{observedAt:at,validUntil:null,nextTransitionAt:null},actionHints:['review']})};
  assert.equal(jobProjectionFor(previous).phase,'result_accepted');
  const record={job_digest:digest,circle:{id:'circle'},state:'claimed',
    jobProjection:createJobProjection({schemaVersion:2,kind:'job',phase:'unknown',reasonCode:'observation_unavailable',
      result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},evidence:{observation:'incomplete'},
      version:{jobDigest:digest,attemptId:'a3',generation:3},times:{observedAt:at,validUntil:null,nextTransitionAt:null},actionHints:[]})};
  const shown=jobPageRecord({record,previous});
  assert.equal(jobProjectionFor(shown).phase,'unknown','terminal prior must not enter active-state fallback');
  assert.notEqual(shown.canSetBorrowerOutcome,true);
  assert.equal(jobDetailVM(shown,{role:'sent'}).result,false);
  assert.equal(jobDetailVM(shown,{role:'sent'}).canResend,false);
});

test('F4 ready result data is not gated by missing or live activity history', async () => {
  const changes={data:{format:'message',message:{markdown:'Returned answer'}}};
  for(const transcript of [{data:null,error:null},{data:{live:true},error:null},{data:null,error:new Error('offline')},{data:{unavailable:true},error:null}]) {
    assert.equal(jobComponents.resultDataPending({ready:true},changes),false);
    const text=renderedText(renderFixture(jobComponents.ResultHistoryStatus,{transcript,onRetry(){}}));
    assert.match(text,/The result is ready/);
    assert.match(text,/Check activity again/);
  }
  assert.equal(jobComponents.resultDataPending({ready:true},{data:null}),true);
  const source=await readFile(new URL('./jobs.jsx',import.meta.url),'utf8');
  assert.match(source,/resultPending = resultDataPending\(page, changes\)/);
  assert.match(source,/<ResultHistoryStatus[^>]*onRetry=\{transcript\.reload\}/);
  assert.doesNotMatch(source,/resultPending =[^;]*transcript/);
});
test('F5 timeout recovery refuses unrelated saved work and preserves pending identities', async () => {
  const {saveDraft}=await import('./compose-draft.mjs');
  for (const extra of [{prompt:'Unrelated work',path:'/unrelated'}, {sending:true}, {uncertainSince:123}, {agentRefusal:{label:'Busy',message:'Wait'}}]) {
    const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
    saveDraft(storage,'intended',{id:'unrelated-draft',prompt:'',sourceKind:'none',path:'',...extra});
    const before=storage.getItem('faravan-compose-draft:intended');
    let navigations=0;
    const dialog=jobComponents.resendJobDialog({storage,jobCircle:'intended',job:{sourceKind:'none'},prompt:'Original task',sourceFolder:'',navigate(){navigations++;}});
    assert.match(renderedText(renderFixture(()=>dialog.children,{})),/messages, uploads, deployments/);
    assert.throws(()=>dialog.onConfirm(),/saved or pending request/);
    assert.equal(storage.getItem('faravan-compose-draft:intended'),before);
    assert.equal(navigations,0);
  }
});
test('resend refuses selective metadata and selected-circle persistence failures', () => {
  for (const failure of ['metadata-throw','metadata-silent','circle-silent']) {
    const values=new Map([['faravan-compose-circle','other']]);
    const storage={getItem:key=>values.get(key)??null,setItem(key,value) {
      if(key==='faravan-compose-draft:intended' && failure==='metadata-throw')throw new Error('quota');
      if(key==='faravan-compose-draft:intended' && failure==='metadata-silent')return;
      if(key==='faravan-compose-circle' && failure==='circle-silent')return;
      values.set(key,value);
    }};
    let navigations=0;
    const dialog=jobComponents.resendJobDialog({storage,jobCircle:'intended',job:{sourceKind:'none'},prompt:'Original task',sourceFolder:'',navigate(){navigations++;}});
    assert.throws(()=>dialog.onConfirm(),failure==='circle-silent'?/select its circle/:/save the new request/);
    assert.equal(navigations,0);
    assert.equal(values.get('faravan-compose-circle'),'other');
  }
});
test('walk copy: both resend entry points say Send again without excluding the previous lender', async () => {
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('./jobs.jsx',import.meta.url),'utf8');
  assert.ok((source.match(/>Send again…<\/Button>/g)||[]).length>=1);
  assert.doesNotMatch(source, /Send to someone else/);
});

test('ready rail includes run evidence and returned-output follow-up explicitly starts a new instruction',async()=>{
 const {readFileSync}=await import('node:fs'),source=readFileSync(new URL('./jobs.jsx',import.meta.url),'utf8');
 const rail=source.slice(source.indexOf('{page.ready ? <aside'),source.indexOf('</aside> : <aside'));
 assert.match(rail,/page.result && <HowItRan details=\{ran.details\}/);
 assert.match(rail,/Send a follow-up job \(new instruction\)/);
});
test('unsupported and failed results explain inspection limits without inventing raw-download or retention support',async()=>{
 const {readFileSync}=await import('node:fs'),source=readFileSync(new URL('./jobs.jsx',import.meta.url),'utf8');
 assert.match(source,/Unsupported result format: \{safeName\(changes.data.format, 'unknown'\)\}/);
 assert.match(source,/This page cannot preview or download this format/);
 assert.match(source,/vm.key === 'failed' && <section/);
 assert.match(source,/Partial output is not available on this page/);
 assert.match(source,/This does not confirm whether any files were kept or actions happened outside the project/);
 assert.doesNotMatch(source,/No partial files are kept/);
 assert.match(source,/initial.ready && jobCircle\s*\? base \+ '\/changes'/);
 assert.match(source,/!changes.data.invalid && !changes.data.blocked\?\.length/);
});

test('delivered lender identities keep one word in the list and page, including applied results', () => {
  for (const applied of [undefined,{branch:'faravan/result',repo:'/repo'}]) {
    const job={job_digest:'delivered',role:'ran',state:'result-accepted',format:'message',
      historyIdentity:{localName:'Sam'},applied};
    const identity=jobVM(job), row=rowsOf(jobsListVM([job],{now:T}))[0];
    assert.equal(identity.word,'Sent back');
    assert.equal(identity.word,identity.listWord);
    assert.equal(row.word,identity.word);
    assert.match(row.who,/ran for Sam/);
  }
});
test('the job page identity preserves the same no-lender qualifier as its row', () => {
  const job={job_digest:'waiting',role:'sent',state:'queued',waiting_reason:'agent_unavailable'};
  assert.equal(jobVM(job).word,'Waiting · no lender');
  assert.equal(rowsOf(jobsListVM([job],{now:T}))[0].word,jobVM(job).word);
  assert.equal(jobVM({...job,waiting_reason:undefined}).word,'Waiting');
});
test('choice disablement explains offline and saving states without changing saved choices', async () => {
  const source=await readFile(new URL('./jobs.jsx',import.meta.url),'utf8');
  assert.match(source,/<BorrowerVerdictNotice busy=\{busy\} offline=\{connection\.offline\}/);
  assert.match(source,/if \(target\.pending \|\| connection\.offline\) return/);
  assert.equal((source.match(/disabled=\{busy \|\| connection\.offline\}/g)||[]).length,2);
  assert.equal(renderFixture(jobComponents.BorrowerVerdictNotice,{busy:false,offline:false}),'');
  const offline=renderFixture(jobComponents.BorrowerVerdictNotice,{busy:false,offline:true});
  assert.match(offline,/role="status"/);
  assert.match(renderedText(offline),/Reconnect to choose or clear your choice\./);
  for(const offline of [false,true]) {
    const saving=renderFixture(jobComponents.BorrowerVerdictNotice,{busy:true,offline});
    assert.match(saving,/role="status"/);
    assert.equal(renderedText(saving),'Saving…');
  }
});

test('cancelled jobs retain their requested agent',()=>{
 const vm=jobsListVM([{job_digest:'cancelled-agent',status:'Cancelled',state:'cancelled',current_attempt:null,role:'sent',local:{title:'Review',agent:'codex'}}]);
 assert.equal(vm.groups.flatMap(group=>group.rows)[0].agent,'Codex');
});
