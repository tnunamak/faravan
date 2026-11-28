import {agentDisplayName as sharedAgentName, agentDisplayText as sharedAgentText} from '../../../lib/v1/agent-display.mjs';
import {blockersFor as displayBlockersFor} from './view-models.mjs';

test('shared agent names accept only own primitive registry keys without coercion', () => {
  const cases = [
    ['claude-code-subscription', 'Claude Code'], ['claude-code-api-key', 'Claude Code'],
    ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['gh-cli', 'GitHub CLI'], ['opencode', 'OpenCode'],
  ];
  for (const [id, expected] of cases) {
    assert.equal(sharedAgentName(id), expected);
    assert.equal(typeof sharedAgentName(id), 'string');
  }
  let coercions = 0;
  const hostile = Object.freeze({
    [Symbol.toPrimitive]() { coercions++; throw new Error('must not coerce'); },
    toString() { coercions++; throw new Error('must not stringify'); },
  });
  for (const id of ['__proto__', 'constructor', 'toString', 'unknown', 'Codex', '',
    null, undefined, 0, true, Symbol('codex'), ['codex'], new String('codex'), hostile]) {
    assert.equal(sharedAgentName(id), 'Agent');
    assert.equal(typeof sharedAgentName(id), 'string');
  }
  assert.equal(coercions, 0);
});

test('shared agent prose keeps punctuation whitespace and machine tokens exact', () => {
  const cases = [
    ['claude-code-subscription claude-code-api-key codex gemini gh-cli opencode',
      'Claude Code Claude Code Codex Gemini CLI GitHub CLI OpenCode'],
    ['"codex", (gemini). \'gh-cli\' opencode.', '"Codex", (Gemini CLI). \'GitHub CLI\' OpenCode.'],
    ['codex\tcodex\n  gemini  ', 'Codex\tCodex\n  Gemini CLI  '],
    ['Codex Gemini CLI Claude Code GitHub CLI OpenCode CODEX Gemini', 'Codex Gemini CLI Claude Code GitHub CLI OpenCode CODEX Gemini'],
  ];
  for (const [input, expected] of cases) assert.equal(sharedAgentText(input), expected);
  const machine = [
    'codex/file', './codex', '../gemini/config', '/tmp/codex', '/codex',
    'C:\\tools\\codex', '.\\gemini', '\\\\server\\codex',
    'https://codex.example/codex?q=gemini', 'codex.example', 'gemini.json',
    'codex-file', 'pre-codex', 'codex_id', 'xcodex', 'codex2', '2codex',
    'claude-code-subscription/config', 'gh-cli.exe', 'opencode.dev',
  ];
  for (const input of machine) {
    assert.equal(sharedAgentText(input), input);
    assert.equal(sharedAgentText('Use "' + input + '", then codex.'),
      'Use "' + input + '", then Codex.');
  }
  assert.equal(sharedAgentText(null), '');
  assert.equal(sharedAgentText(undefined), '');
  assert.equal(sharedAgentText(42), '42');
  let coercions = 0;
  assert.equal(sharedAgentText({toString() { coercions++; return 'codex'; }}), 'Codex');
  assert.equal(coercions, 1);
});

test('shared agent prose reaches frozen server blockers without rewriting their input', () => {
  const detail = 'Use codex, (gemini). Keep /tmp/codex and https://gemini.example unchanged.';
  const item = Object.freeze({key:'readiness_requirement', status:'blocked', detail,
    label:'Synthetic check', action:'Check again'});
  const server = Object.freeze({items:Object.freeze([item]), first:item, canLend:false});
  const status = Object.freeze({lending_blockers:server});
  const args = Object.freeze({status, agents:Object.freeze([])});
  const result = displayBlockersFor(args);
  assert.equal(result.source, 'server');
  assert.equal(result.items[0].detail,
    'Use Codex, (Gemini CLI). Keep /tmp/codex and https://gemini.example unchanged.');
  assert.equal(result.first, result.items[0]);
  assert.notEqual(result.items[0], item);
  assert.equal(item.detail, detail);
  assert.equal(server.items[0], item);
});

import {jobHeadingVM} from './view-models.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {hostChooseVM} from './view-models.mjs';


test('lender return wording agrees between job identity and list for the same role',async()=>{
  const {jobVM,jobsListVM}=await import('./view-models.mjs');
  for(const state of ['result-accepted','finished']) for(const name of ['Ana','']) for(const applied of [undefined,{branch:'faravan/result'}]) {
    const job={job_digest:'sha256:'+'a'.repeat(64),role:'ran',state,applied,
      historyIdentity:{personName:name},format:'message'};
    const vm=jobVM(job,'ran');
    const row=jobsListVM([job]).groups.flatMap(group=>group.rows)[0];
    assert.equal(vm.word,'Sent back');
    assert.equal(vm.listWord,vm.word);
    assert.equal(row.word,vm.word);
    assert.equal(vm.requester,name);
  }
});

test('private and public requirements use the terminal while a LAN circle can start in the app', () => {
  for(const method of ['private','public']) {
    const vm=hostChooseVM({method,name:'Friends'});
    assert.equal(vm.command,'faravan host --tunnel '+method+' --circle-name Friends');
    assert.equal(vm.start,null);
  }
  const lan=hostChooseVM({method:'lan',name:'Friends'});
  assert.deepEqual(lan.start,{tunnel:'lan',name:'Friends'});
});

import {adaptLegacyJob, qualifyJobProjection} from '../../../lib/v1/state-projection.mjs';
const storedPass = {id:'test-run',state:'passed',at:'2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',
  configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
import {homePeopleVM,lendingVM, lendingQuotaLinesVM, lendingLimitsVM, requestVM, jobRowVM, jobPageVM, presenceLine, failureVM, plainFolderResultCaption, personName, needsYouCount, machineVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// Hand-built, synthetic responses from app.mjs homeView/lendingView/approval/
// withBorrowerOutcome/presence at 07a69a1. No live agents, servers or credentials.
const now = Date.parse('2026-10-19T15:00:00Z');
const localClock = at => new Intl.DateTimeFormat('en-US', {hour:'numeric',minute:'2-digit'}).format(at);
test('Jobs identifies a send made under the agent permission',()=>{
  const value=jobsListVM([{job_digest:'sha256:a',role:'sent',state:'queued',local:{title:'Parser',sentByAgent:true}}]);
  assert.equal(value.groups[0].rows[0].sentByAgent,true);
});
const localDateClock = at => new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(at);
const status = {observedAt:now, iconState:'Lending on', lending:{enabled:true,
  circle:'weekend',mode:'ask',status:'idle',paused:false,current:null}, currentJob:null,
  attention:[],circles:[{id:'weekend',name:'Weekend projects'}]};
const identity = {requester:'sam',deviceName:'Sam',localName:null,memberPresent:true,
  rosterFresh:true,rootMatches:true,circleMatches:true};
const card = {id:'review-1',identity,requester:'sam',requesterName:'Sam',localName:null,
  jobDigest:'sha256:job',job:{circle:'weekend',author:'sam'},prompt:'Fix the parser.\nKeep the API.',
  source:{kind:'archive',artifact:{bytes:512}},sourceFiles:212,harness:'codex',model:[],
  runtimeSeconds:1200,network:'provider-only',startsNow:true,expiresAt:now+600000,
  protection:{source:'read-only-preflight',satisfied:true}};
const job = {job_digest:'sha256:job',status:'Waiting',state:'queued',
  historyIdentity:{author:'sam',deviceName:'MacBook',localName:'Sam'},
  local:{title:'Fix parser',prompt:'Fix the parser.',source:'sam/booking-site'},
  waitingTiming:{submittedAt:'2026-10-19T15:00:00Z',expiresAt:'2026-10-20T15:00:00Z'},
  canSetBorrowerOutcome:false};
const viewer = {id:'sam',role:'borrower',now,timeZone:'UTC'};
const freeze = value => {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
};
[status,card,job,viewer].forEach(freeze);

const lendingCases = [
  ['today ready',withLendingProjection(status),'ready','Ready for requests','on'],
  ['today off',withLendingProjection({enabled:false,status:'paused'},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),'off','Lending is off','paused'],
  ['launch unknown',withLendingProjection({}, {intent:'unknown',intentState:null,admission:'unknown',admissionReason:null,execution:'unknown'}),'unknown','Status unavailable','needs-you'],
  // Proposed S1.1 projections are clearly separate from today's API fixture.
  ['pause',withLendingProjection({state:'paused',until:now},{intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused'}),'paused','Lending is paused','paused'],
  ['blocked',withLendingProjection({state:'blocked',reason:'docker_signed_out'}, {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'}),'blocked',
    'Lending can’t start here','needs-you'],
  ['running',withLendingProjection({execution:{state:'running',job:'job-1'}},{intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'job-1'}),'running',"Running a job",'on'],
  ['daily limit',withLendingProjection({enabled:true,status:'paused',reason:'daily_limit'},{intent:'on',intentState:'resting',admission:'blocked',admissionReason:'daily_limit',dailyLimitReached:true}),'resting',
    'Done for today','paused'],
  ['reserve',withLendingProjection({enabled:true,reason:'quota_reserve'},{intent:'on',intentState:'resting',admission:'blocked',admissionReason:'quota_reserve'}),'resting','Resting','on'],
  ['schedule',withLendingProjection({state:'resting',until:now+10800000},{intent:'on',intentState:'resting',admission:'blocked',admissionReason:'user_active'}),'resting','Resting','on'],
  ['partial block',withLendingProjection({...status,attention:[{label:'Sign in to Claude Code again.'}]}),
    'ready','Ready for requests','needs-you'],
  ['intent precedes running',withLendingProjection({intent:'off',state:'running'},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),'off','Lending is off','paused'],
];
test('unknown weekly sharing caps are omitted rather than inferred from provider reserves', () => {
  const cases = [
    ['Codex lending', {limits:{quotaReserve:30, lendingPolicy:{strategy:'fixed_share', strategyParams:{fixedSharePct:20}}}}, [{id:'codex',useForLending:true}]],
    ['Claude lending', {limits:{quotaReserve:30}}, [{id:'claude-code-subscription',useForLending:true}]],
    ['no provider list', {limits:{weeklySharingCap:10, quotaReserve:30}}, undefined],
    ['malformed candidate', {limits:{weeklySharingCap:{percent:10}, quotaReserve:'30'}}, [{id:'codex',useForLending:true}]],
  ];
  for (const [name, lending, agents] of cases) {
    const rows = lendingLimitsVM(lending, undefined, agents);
    assert.equal(rows.find(row => row.label === 'Weekly sharing cap'), undefined, name);
    assert.equal(rows.some(row => row.label === 'Keep for yourself'), name === 'Claude lending' || name === 'no provider list', name);
  }
});

test('quota lines use objective amounts only when the account is admitted', () => {
  const rows = lendingQuotaLinesVM({accounts:[
    {provider:'claude', decision:{status:{line:'Stale status must not replace the current projection.'},
      availability:{admitted:true, objective:{lendablePoints:{seven_day:24.26}}},
      windows:[{window_id:'seven_day',window_minutes:10080}]}},
    {provider:'codex', decision:{status:{line:'Ready to lend to a friend when a job arrives.'},
      availability:{admitted:false, objective:{lendablePoints:{'codex:10080':null}},
        status:{line:'Holding — waiting for a quota reading.'}},
      windows:[{window_id:'codex:10080',window_minutes:10080}]}}
  ]});
  assert.deepEqual(rows, [
    {key:'claude/seven_day',label:'Claude Code · this week',text:"About 24.3% of this week's quota is open to lend now."},
    {key:'codex/codex:10080',label:'Codex · this week',text:'Holding — waiting for a quota reading.'}
  ]);
});

test('a held account says its reason once and shows which window has nothing open', () => {
  const rows = lendingQuotaLinesVM({accounts:[{provider:'claude', decision:{
    availability:{admitted:false, objective:{lendablePoints:{seven_day:0, five_hour:20}},
      status:{line:'Holding — your reserve covers everything spare. It clears on its own when spare quota grows or your own use drops.'}},
    windows:[{window_id:'seven_day',window_minutes:10080},{window_id:'five_hour',window_minutes:300}]}}]});
  assert.deepEqual(rows, [{key:'claude', label:'Claude Code',
    text:"Holding — your reserve covers everything spare. It clears on its own when spare quota grows or your own use drops. "
      + "This week: 0%. This 5-hour window: about 20%."}]);
});

test('zero quota remains explicit and keeps the per-job approval qualifier', () => {
  const [row] = lendingQuotaLinesVM({accounts:[{provider:'claude', decision:{
    availability:{admitted:true, objective:{lendablePoints:{seven_day:0}}},
    windows:[{window_id:'seven_day',window_minutes:10080}],
  }}]}, true);
  assert.deepEqual(row, {
    key:'claude/seven_day', label:'Claude Code · this week',
    text:"0% of this week's quota is open to lend now; you approve each job.",
  });
});
for (const [label,input,state,headline,glyph] of lendingCases) test('lending: '+label,()=>{
  const value=lendingVM(freeze(input));assert.equal(value.state,state);
  assert.equal(value.headline,headline);assert.equal(value.glyph,glyph);
});

const failureCases = [
  ['agent_signed_out','prepare','borrower','Waiting · Ana’s computer needs a moment'],
  ['agent_signed_out','prepare','lender','Claude Code signed out. Sam’s job went back to the queue.'],
  ['sandbox_not_ready','prepare','borrower','Waiting · Ana’s computer needs a moment'],
  ['stopped_by_lender','run','borrower',"Ana stopped this run. Changes up to the stop weren’t kept."],
  ['stopped_by_lender','run','lender','You stopped Sam’s job after 4 min.'],
  ['lease_expired','run','borrower',"Interrupted · Ana’s computer stopped answering, 4 minutes into the job. The agent may have done part of the work, and anything it did outside your code (for example, sending an email) may have happened. Nothing came back."],
  ['agent_exit_nonzero','run','borrower',"The agent couldn't finish."],
  ['agent_group_not_ceased','run','borrower',"The agent couldn't finish."],
  ['agent_run_failed','run','borrower',"The agent couldn't finish."],
  ['wall_timeout','run','borrower',"The agent couldn't finish: it hit the 20-minute limit."],
  ['requirements_unsupported','claim','borrower','No one in Weekend projects lends Gemini. Choose another agent.'],
  ['candidate_invalid','deliver','borrower','The lender’s computer could not send the work back'],
  ['unknown /private/account','run','borrower',"Interrupted · Ana’s computer stopped answering, 4 minutes into the job. The agent may have done part of the work, and anything it did outside your code (for example, sending an email) may have happened. Nothing came back."],
];
for (const [code,phase,role,headline] of failureCases) test('failure: '+code+' '+role,()=>{
  const result=failureVM(code,phase,{role,lender:'Ana',borrower:'Sam',
    agent:code==='requirements_unsupported'?'Gemini':'Claude Code',
    minutes:code==='wall_timeout'?20:4,circle:'Weekend projects'});
  assert.equal(result.headline,headline);
  assert.doesNotMatch(JSON.stringify(result),/unknown \/private|lease_expired|candidate_invalid/);
});
// T21: nothing reruns by itself after the run started. Only the sender sends it again, as a new job.
test('no failure copy promises an automatic retry, and every sender-side failure after a start offers "Send it again…"',()=>{
  const promise=/\b(?:try|tries|trying)\s+again|will\s+(?:retry|run\s+again|be\s+retried)|retrying|automatically|rerun|re-run|waiting for someone else/i;
  const codes=['lease_expired','lease_uncertain','cessation_unverified','network','sbx_crash','unknown /x','stopped_by_lender','wall_timeout','output_too_large','execution_failed','tests_failed','candidate_missing','candidate_invalid','git_commit_unverified','agent_signed_out','sandbox_not_ready','requirements_unsupported','expired'];
  for(const code of codes) for(const phase of ['claim','prepare','run','deliver']) for(const role of ['borrower','lender']) {
    const result=failureVM(code,phase,{role,lender:'Ana',borrower:'Sam',agent:'Codex',minutes:9,at:'2:52 PM',circle:'Weekend projects'});
    const text=[result.headline,result.reason,...result.actions.map(a=>a.label)].join(' | ');
    assert.doesNotMatch(text,promise,code+' '+phase+' '+role+': '+text);
  }
  const afterStart=['lease_expired','lease_uncertain','cessation_unverified','network','unknown /x','stopped_by_lender','wall_timeout','execution_failed','candidate_invalid'];
  for(const code of afterStart) assert.ok(failureVM(code,'run',{role:'borrower',lender:'Ana'}).actions.some(a=>a.label==='Send it again…'),code);
  assert.equal(failureVM('lease_uncertain','run',{role:'lender',borrower:'Sam'}).headline,'Interrupted · You don’t need to do anything. If Sam sends it again, you’ll be asked like any request.');
});
test('failure families keep delivery, request and private actions distinct',()=>{
  for(const code of ['candidate_missing','candidate_invalid','git_commit_unverified'])
    assert.equal(failureVM(code,'deliver').actions[0].label,'Send it again…');
  for(const code of ['requirements_unsupported','policy_unenforceable','expired'])
    assert.equal(failureVM(code,'claim','lender').headline,'');
  for(const code of ['lease_uncertain','network','sbx_crash'])
    assert.equal(failureVM(code,'run','lender').actions[0].label,'Copy details');
  for(const code of ['output_too_large','execution_failed','tests_failed']) {
    assert.equal(failureVM(code,'run').actions[0].label,'View what it did');
    assert.equal(failureVM(code,'run').actions[1].label,'Send it again…');
  }
});

const presenceCases = [
  ['today aggregate',{online:2,total:3,basis:'recent-activity'},'Waiting'],
  ['approval overrides aggregate',{online:0,total:3,basis:'recent-activity',approvalFor:'sam'},'Waiting for you to say yes'],
  ['approval belongs to Ana',{person:{name:'Ana'},mode:'ask'},'Ana says yes before each job'],
  ['fresh ready',{state:'ready',last_poll_at:now-89999},'Lending now'],
  ['away boundary',{state:'ready',last_poll_at:now-90000},'Away · last seen 1 min ago'],
  ['offline boundary',{state:'ready',last_poll_at:now-900000},'Offline since Oct 19, 2026, 2:45 PM'],
  ['resting',{state:'resting',last_poll_at:now,until:now+10800000},'Resting until 6:00 PM'],
  ['off',{state:'off'},'Not lending'],
  ['all declined',{waiting_reason:'all_declined'},'Nobody can take this job right now.'],
];
for (const [label,input,line] of presenceCases) test('presence: '+label,()=>{
  assert.equal(presenceLine(freeze(input),viewer),line);
});
test('missing or future presence evidence is never live',()=>{
  for(const input of [{},{state:'ready'},{state:'ready',last_poll_at:now+1}])
    assert.equal(presenceLine(input,viewer),'Waiting');
});
test('names: own identity, petname, chosen name, current device name, missing',()=>{
  assert.equal(personName({id:'sam',name:'Samuel'},{sam:'Friend'},viewer),'You');
  assert.equal(personName({id:'ana',name:'Ana'},{ana:'Annie'},viewer),'Annie');
  assert.equal(personName({id:'ana',name:'Ana'},{},viewer),'Ana');
  assert.equal(personName(identity,{},{}),'Sam');
  assert.equal(personName({key_id:'sha256:secret'},{},{}),'');
  assert.equal(personName(null),'');
});
test('request copy preserves the full prompt, actions and actual local deadline',()=>{
  const value=requestVM(card);
  assert.equal(value.headline,'Sam asked for help');assert.equal(value.prompt,card.prompt);
  assert.equal(value.reason,'No rush. This request waits until '+localDateClock(card.expiresAt)+'.');
  assert.deepEqual(value.actions.map(a=>a.label),['Run it','Decline']);
  assert.equal(value.timeLimit,'20 min');assert.equal(value.startsNow,true);
});
test('request cannot offer Run it without protection or current identity evidence',()=>{
  for (const patch of [{protection:null},{protection:{satisfied:false}},
    {identity:{...identity,rosterFresh:false}}])
    assert.deepEqual(requestVM({...card,...patch}).actions.map(a=>a.label),['Decline']);
});
test('copy table repo and file count are display facts, never raw source objects',()=>{
  const value=requestVM({...card,source:{kind:'git',url:'https://github.com/sam/booking-site.git'}});
  assert.equal(value.source,'sam/booking-site · 212 files');
  assert.equal(typeof value.source,'string');
});
for(const [status,expected] of [['Waiting','Waiting'],['Starting','Waiting'],['Running','Waiting'],
  ['Finished','Ready to review'],['Failed','Failed'],['Expired','Expired'],['Cancelled','Cancelled']])
  test('job: '+status,()=>assert.equal(jobRowVM({job_digest:job.job_digest,status,...(status==='Cancelled'?{current_attempt:null}:{})},viewer).headline,expected));
test('job execution and cancellation evidence remain conservative',()=>{
  assert.equal(jobRowVM({state:'running',status:'Running',executionProof:false},viewer).headline,'Waiting');
  assert.equal(jobRowVM({state:'cancelled',status:'Cancelled',compute_stopped:true},viewer).headline,'Cancelled');
});
test('result copy covers review, use, disclosures and private feedback',()=>{
  const value=jobPageVM({...job,state:'result-accepted',status:'Finished',canSetBorrowerOutcome:true},{summary:'Fixed parser.'},viewer);
  assert.equal(value.summary,'Fixed parser.');assert.equal(value.feedback,'Did this help? Only you see this.');
  assert.ok(value.sections.includes('How it ran'));assert.ok(value.sections.includes('What you asked'));
  assert.equal(value.actions[0].label,'Download as .zip');
});
test('uninvolved viewer gets no title, prompt, result or action',()=>{
  const value=jobPageVM({...job,local:null},{summary:'private'},{id:'stranger'});
  assert.equal(value.title,'');assert.equal(value.summary,'');assert.deepEqual(value.actions,[]);
});
test('all adapters are deterministic on frozen inputs and return serializable display data',()=>{
  const calls=[()=>lendingVM(status),()=>requestVM(card),()=>jobRowVM(job,viewer),
    ()=>jobPageVM(job,{},viewer),()=>presenceLine({online:0,total:2,basis:'recent-activity'},viewer),
    ()=>failureVM('network','run'),()=>personName(identity)];
  for (const call of calls) {const result=call();assert.deepEqual(result,call());
    assert.deepEqual(JSON.parse(JSON.stringify(result)),result);}
});

test('a pending approval does not hide explicit execution proof',()=>{
  assert.equal(lendingVM({enabled:true,status:'awaiting-approval',current:'attempt-1'}).state,'unknown');
  const status={intent:{on:true,state:'ready'},execution:{state:'running',job:'attempt-1',person:'Sam'},
    lending:{enabled:true,status:'running',current:'attempt-1'},runningJob:{requester:'Sam'}};
  assert.match(lendPageVM(status).exec.text,/Sam’s job is running/);
  assert.match(lendPageVM(status,{approvals:[{id:'approval-1'}]}).exec.text,/Sam’s job is running/);
  assert.equal(machineVM(status,{name:'This computer'},{approvals:[{id:'approval-1'}]}).line,'Running Sam’s job');
});
test('historical attribution uses signed device metadata and a viewer-local name',()=>{
  const value=jobPageVM({...job,historyIdentity:{author:'sam',localName:'Sam',deviceName:'his MacBook'}},{},viewer);
  assert.equal(value.attribution,'Sent by Sam from his MacBook');
});

test('unknown state and request cause never invent availability or a missing agent',()=>{
  assert.equal(lendingVM({state:'raw_private_failure'}).state,'unknown');
  assert.equal(failureVM('requirements_unsupported','claim').headline,'Nobody can take this job right now.');
  assert.equal(presenceLine({waiting_reason:'all_declined',mode:'ask',person:{name:'Ana'}},viewer),
    'Nobody can take this job right now.');
  assert.equal(personName({type:'device',id:'mac'}, {}, {deviceId:'mac'}),'This computer');
});

test('the Home badge counts every needs-you item once, and needs_you wins over attention', () => {
  assert.equal(needsYouCount(), 0);
  // Without a status list, each approval counts.
  assert.equal(needsYouCount({approvals: [card], home: status}), 1);
  // The status attention list already holds the approval (approvalId): not counted twice.
  const listed = {...status, attention: [{label: 'This job needs your review', approvalId: card.id}]};
  assert.equal(needsYouCount({approvals: [card], home: listed}), 1);
  assert.equal(needsYouCount({approvals: [card, {...card, id: 'review-2'}],
    home: {...listed, attention: [...listed.attention, {label: 'Sign in to Claude Code again.'}]}}), 3);
  assert.equal(needsYouCount({approvals: [], home: {...status, attention: [{}, {}], needs_you: [{}]}}), 1);
  assert.equal(needsYouCount({approvals: null, home: {attention: 'nope'}}), 0);
  const zero={job_digest:'zero',role:'sent',status:'Finished',resultSummary:{noChanges:true}};
  assert.equal(needsYouCount({approvals:[],home:status,jobs:[zero]}),0);
});

test('the machine chip names this computer and gives one honest line per state', () => {
  const devices = {name: "Ana's MacBook"};
  const readyOptions = {readiness:{ready:true,checks:[]},agents:[{id:'codex',useForLending:true,installed:true,signedIn:true}]};
  const on = machineVM({...status, lendingPolicy:{accounts:[{provider:'codex',decision:{availability:{admitted:true}}}]}}, devices, readyOptions);
  assert.deepEqual([on.name, on.line, on.kind, on.word], ["Ana's MacBook", 'Ready for requests', 'on', 'On']);
  const lending = patch => ({...status, lending: {...status.lending, ...patch}});
  const runningHome = withLendingProjection(lending({status:'running',current:'attempt-1'}),
    {intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'attempt-1'});
  const cases = [
    [lending({enabled: false, circle: null}), 'off', 'Lending is off'],
    [{...lending({paused: true}),state:'paused'}, 'off', 'Paused'],
    [runningHome, 'run', 'Running a job'],
    [{...runningHome, runningJob: {requester: 'Sam'}}, 'run', 'Running Sam’s job'],
    [withLendingProjection({...lending({paused: true,status:'running',current:'a1'}), state:'paused', runningJob:{requester:'Sam'}},
      {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused',execution:'finishing',executionJob:'a1'}), 'run', 'Finishing Sam’s job'],
    [withLendingProjection(lending({reason:'sandbox_not_ready',status:'waiting_for_sandbox'}),
      {intent:'on',intentState:'starting',admission:'unknown',admissionReason:null}), 'off', 'Status unavailable'],
    [withLendingProjection(lending({reason:'daily_limit',today:{jobs:1,jobLimit:1}}),
      {intent:'on',intentState:'resting',admission:'blocked',admissionReason:'daily_limit',dailyLimitReached:true}), 'off', 'Done for today'],
  ];
  for (const [home, kind, line] of cases) {
    const chip = machineVM({...home}, devices, readyOptions);
    assert.deepEqual([chip.kind, chip.line], [kind, line], line);
  }
  assert.deepEqual(machineVM(undefined, undefined), {name: 'This computer', line: 'Checking this computer…', kind: 'wait', word: 'Checking'});
});

// U3: the Lending page view model. One test row per state of the mockups (lend.*).
import {lendPageVM, agentRowVM, limitsSummary, scheduleText, computerFactsVM} from './view-models.mjs';
const claude = {id:'claude-code-subscription',useForLending:true,installed:true,signedIn:true,run:{model:'Sonnet',effort:'medium'}};
const codex = {id:'codex',useForLending:true,installed:true,signedIn:true,run:{}};
const page = (top, lending = {}, extra = {}) => {
  const status={...top,lending:{enabled:true,limits:{timeZone:'UTC'},...lending}};
  const state=top.intent?.state ?? (top.state==='running'?'ready':top.state ?? (lending.enabled===false?'off':'ready'));
  const intent=state==='off'?'off':state==='paused'?'paused':'on';
  const cap=top.reason==='daily_limit';
  const reason=cap?'daily_limit':top.reason ?? (state==='off'?'off':state==='paused'?'paused':state==='outside'?'outside_hours':state==='resting'?'quota_reserve':state==='update'?'required_update':state==='blocked'?'sandbox_not_ready':null);
  const admission=state==='ready'?'allowed':state==='starting'?'unknown':'blocked';
  const execution=top.execution?.state ?? (top.state==='running'?'running':'idle');
  const projection={intent,intentState:state,admission,admissionReason:admission==='allowed'||admission==='unknown'?null:reason,
    execution,executionJob:['running','finishing','stopping'].includes(execution)?top.execution?.job ?? 'fixture-job':null,
    dailyLimitReached:cap};
  const projected=withLendingProjection(status,{...projection});
  return lendPageVM(projected,{agents:[claude,codex],now,readiness:{ready:true,checks:[]},...extra});
};
const row = vm => [vm.kind, vm.headline, vm.reason];
const pausedUntil = now + 60 * 60_000;

test('lendPageVM: intent titles stay consistent through effective states', () => {
  assert.deepEqual(row(page({state:'ready',lendingPolicy:{accounts:[{provider:'claude',decision:{availability:{admitted:true}}},{provider:'codex',decision:{availability:{admitted:true}}}]}})), ['ready', 'Ready for requests', 'A new request is checked against the quota available when it arrives.']);
  const running = page({state:'running', runningJob:{requester:'Sam'},execution:{state:'running',job:'job-1',person:'Sam'}}, {status:'running'});
  assert.equal(running.kind, 'running'); assert.equal(running.headline, 'Running Sam’s job');
  assert.match(running.exec.text, /Sam’s job is running/);
  const paused = page({intent:{on:true,state:'paused',until:pausedUntil},execution:{state:'running',job:'job-2',person:'Sam'},runningJob:{requester:'Sam'}}, {status:'running'});
  assert.deepEqual(row(paused), ['running','Running Sam’s job','Paused until '+localClock(pausedUntil)+'. No new jobs start.']);
  assert.deepEqual([paused.exec.finishing,paused.exec.canStop],[false,true], 'pausing admission does not relabel a running execution as finishing');
  assert.deepEqual(row(page({state:'off'}, {enabled:false})), ['off','Lending is off','No new jobs start on this computer.']);
  for (const state of ['resting','outside','update']) assert.notEqual(page({state}).headline,'Ready for requests');
  const checking = page({state:'starting'}, {}, {readiness:null,agents:[{...claude,signedIn:null},{...codex,signedIn:null}]});
  assert.equal(checking.kind,'unknown'); assert.equal(checking.headline,'Status unavailable');
});

test('lendPageVM: a cleared legacy circle keeps the Resume now recovery', () => {
  const recovery=page({intent:{on:true,state:'blocked',reason:'lending_not_started'},state:'blocked'},
    {enabled:false,circle:null});
  assert.equal(recovery.blockers.needsYou.find(item=>item.key==='lending')?.action,'Resume now');
});

test('lendPageVM: signed-out agents use the shared blocker and retain the switch', () => {
  const options = {agents:[{...claude,signedIn:false},codex],readiness:{ready:true,checks:[]},now};
  const input=withLendingProjection({state:'ready',lending:{enabled:true},lendingPolicy:{accounts:[{provider:'codex',decision:{availability:{admitted:true}}}]}}, {intent:'on',intentState:'ready',admission:'allowed'});
  const vm = lendPageVM(input,options);
  assert.equal(vm.headline,'Ready for requests'); assert.equal(vm.switch.on,true);
  assert.equal(vm.blockers.byAgent[claude.id].status,'blocked');
  assert.equal(vm.reason,'A new request is checked against the quota available when it arrives.');
  assert.deepEqual(vm.needsList,[]); assert.equal(vm.banner,null);
  const both = lendPageVM(input,{...options,agents:[{...claude,signedIn:false},{...codex,signedIn:false}]});
  assert.equal(both.kind,'ready'); assert.equal(both.switch.on,true);
  assert.doesNotMatch(JSON.stringify(vm),/count(ed)? (toward|against)|Remind me/);
});



test('lendPageVM: unknown causes do not invent failures; unsupported has no switch', () => {
  const vm = page({state:'blocked',reason:'unheard_of'});
  assert.equal(vm.headline,'Jobs can’t start'); assert.doesNotMatch(vm.reason,/signed out|failed/i);
  const unsupported=lendPageVM(withLendingProjection({reason:'platform_unsupported',lending:{enabled:false}}, {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'platform_unsupported'}),{now});
  assert.equal(unsupported.kind,'unsupported'); assert.equal(unsupported.switch,null);
});

test('lendPageVM: no control reaches another device, and there is no per-circle switch', () => {
  for (const top of [{state:'ready'}, {state:'paused'}, {state:'running'}, {state:'off'}]) {
    const vm = page(top, {current:{}, status:'running'});
    assert.ok(vm.actions.every(a => ['lending.resume', 'lending.stop'].includes(a.op)), JSON.stringify(vm.actions));
    assert.doesNotMatch(JSON.stringify(vm), /Remind me|Pause new jobs…|20 more minutes|your MacBook/);
  }
});

test('lendPageVM: meters show only readings the app has', () => {
  const lending = {limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60}};
  const jobs = lendPageVM({state:'ready', lending:{enabled:true,...lending}}, {use:{jobs:2,max:3}, now});
  assert.deepEqual(jobs.meters.map(m => [m.label, m.value, m.of, m.percent]), [['Jobs today', '2', 'of 3', 67]]);
  const allowance = {provider:'claude', remaining:51, observedAt:now - 60000, resetsAt:now + 86400000};
  const both = lendPageVM({state:'ready', allowance, lending:{enabled:true,...lending}}, {use:{jobs:2,max:3}, now});
  assert.deepEqual([both.meters[1].label, both.meters[1].value, both.meters[1].of], ['Claude Code this week', '51%', 'of your weekly quota unused']);
  assert.equal(both.meters[1].note, 'checked '+localClock(allowance.observedAt)+' · resets Tuesday', 'the reading says when it was taken and when the week resets');
  assert.doesNotMatch(JSON.stringify(both.meters), /for friends|for each job/, 'no per-job or per-friend allowance percentages');
  const stale = lendPageVM({state:'ready', allowance:{...allowance, observedAt:now - 3 * 86400000}, lending:{enabled:true}}, {now});
  assert.deepEqual(stale.meters, [], 'a reading older than a day is not shown');
});



test('limitsSummary and scheduleText read the saved rules', () => {
  const limits = {dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30};
  assert.equal(limitsSummary({limits}).map(x => x.text).join(''), 'Up to 3 jobs and 60 minutes a day, 20 minutes per job. Keep 30% of my weekly Claude allowance for me.');
  assert.deepEqual(limitsSummary({limits}).filter(x => x.strong).map(x => x.text), ['3 jobs', '60 minutes', '20 minutes', '30%']);
  assert.equal(limitsSummary({}).length, 0);
  assert.equal(limitsSummary({limits:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30}}).map(x=>x.text).join(''),
    'Jobs must fit before reset. Keep 30% of my weekly Claude allowance for me.');
  assert.equal(scheduleText({days:[1,2,3,4,5], from:'22:00', to:'07:00', weekends_all_day:true}), 'Weeknights 10 PM–7 AM and all weekend.');
  assert.equal(scheduleText({days:[1,2,3,4,5], from:'25:00', to:'07:00'}), '');
  assert.equal(scheduleText(undefined), '');
});

test('agentRowVM: one line per agent, in the mockups’ order', () => {
  assert.deepEqual(agentRowVM(claude), {id:claude.id, name:'Claude Code', icon:'terminal', state:'ready', word:'Ready', kind:'on', note:'',  sub:['Signed in', 'ready', 'Sonnet', 'medium effort'], warn:false, lending:true, canChoose:true, canEnable:true, canCheck:false, checking:false, canSignIn:false});
  assert.deepEqual(agentRowVM(codex).sub, ['Signed in', 'ready', 'Default model']);
  assert.deepEqual([agentRowVM({...claude,signedIn:false}).state, agentRowVM({...claude,signedIn:false}).warn, agentRowVM({...claude,signedIn:false}).sub], ['signin', true, ['Signed out']]);
  assert.equal(agentRowVM({id:'codex', installed:false}).state, 'install');
});

test('agentRowVM lets an installed signed-out agent be chosen and checked', () => {
  const row=agentRowVM({id:'codex',installed:true,signedIn:false,signInSupported:true});
  assert.equal(row.canChoose,true);
  assert.equal(row.canEnable,false);
  assert.equal(row.canCheck,true);
  assert.equal(row.canSignIn,true);
});

test('lending proxy rows show one product card and require proxy sign-in before lending', () => {
  const signedOut={id:'codex-lending',canonical_id:'codex',installed:true,signedIn:false,proxySignedIn:false,
    useForLending:false,lendingSignInTarget:'codex-lending',lendingSignInSupported:true,signInSupported:true,canChoose:false};
  const ownerView={...signedOut,id:'codex',signedIn:true,auth_strategy:'provider-file-generation'};
  const [lendingView]=agentSectionsVM([ownerView]).shown;
  assert.equal(lendingView.id,'codex-lending');
  assert.equal(lendingView.signedIn,false,'native owner sign-in does not replace proxy sign-in');
  assert.equal(lendingView.auth_strategy,'docker-native-oauth');
  const [shown]=agentSectionsVM([signedOut,{...signedOut,id:'codex'}]).shown;
  const row=agentRowVM(shown);
  assert.equal(row.id,'codex');
  assert.equal(row.name,'Codex');
  assert.equal(row.canChoose,false);
  assert.equal(row.canSignIn,true);

  const ready=agentRowVM({...signedOut,signedIn:true,proxySignedIn:true,canChoose:true});
  assert.equal(ready.canChoose,true);
  assert.equal(ready.canSignIn,false);
  const missingAgent=agentRowVM(agentSectionsVM([{...signedOut,installed:false,signedIn:true,proxySignedIn:true}]).shown[0]);
  assert.equal(missingAgent.canChoose,false);
});









// U9: the setup checklist, from /api/readiness checks, /api/agents and the lending view.
import {setupVM} from './view-models.mjs';
const okChecks = [{name:'sbx_install',ok:true},{name:'sbx_version',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}];
const circle = {id:'weekend',origin:'https://circle.test',name:'Weekend projects', enrollment:{state:'approved'},rosterMembershipVerified:true};
const setupLendingReady = {agents:['claude-code-subscription','codex'].map(id=>({id,checks:[{id:'signed_in',state:'pass'}]}))};
const setup = (over = {}) => setupVM({readiness:{ready:true,checks:okChecks}, agents:[claude, codex],
  status:{lending:{limits:{dailyJobs:3,dailyMinutes:60}}}, lendingReadiness:setupLendingReady, devices:{name:'Ana’s MacBook Pro'}, circle, ...over});
const states = vm => vm.steps.map(s => s.id + ':' + s.state).join(' ');

test('setupVM: everything passed gives a ready summary with the saved rules', () => {
  const vm = setup({lendingReadiness:setupLendingReady});
  assert.equal(states(vm), 'sandboxes:ok docker-account:ok agent:claude-code-subscription:ok agent:codex:ok circle:ok');
  assert.deepEqual([vm.ready, vm.headline, vm.eyebrow], [true, 'Your computer is ready', '']);
  assert.equal(vm.summary.title, 'Last step');
  assert.equal(vm.summary.text, 'Lends Claude Code and Codex · asks you before each job · up to 3 jobs and 60 minutes a day.');
  assert.equal(vm.summary.waiting, '');
});
test('setupVM: rejected and expired circles cannot complete lending setup', () => {
  for (const state of ['rejected','expired']) {
    const vm=setup({circle:{...circle,enrollment:{state}}});
    assert.equal(vm.ready,false);
    assert.equal(vm.steps.find(step=>step.id==='circle').state,'need');
  }
});

test('setupVM: explicit membership phase overrides raw enrollment and invalid projection fails closed', () => {
  const approved={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
  const invalid={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'pending',origin:true},invitationPolicy:'unknown'};
  assert.equal(setup({circle:{...circle,enrollment:{state:'pending'},membershipProjection:approved}}).steps.find(s=>s.id==='circle').state,'ok');
  assert.equal(setup({circle:{...circle,enrollment:{state:'approved'},membershipProjection:invalid}}).steps.find(s=>s.id==='circle').state,'need');
});

test('setupVM: while nothing has loaded, steps are in progress and the button waits', () => {
  const vm = setupVM({circle});
  assert.equal(states(vm), 'sandboxes:now docker-account:now agent:claude-code-subscription:now agent:codex:now circle:ok');
  assert.equal(vm.ready, false);
  assert.equal(vm.summary.waiting, 'Finish the steps that need you to turn lending on.');
});

test('setupVM: Docker Sandboxes missing is the one thing to do and everything after it waits for it', () => {
  const vm = setup({readiness:{ready:false, checks:[{name:'sbx_install',ok:false,label:'Docker Sandboxes is not installed.'},{name:'sbx_daemon',ok:null},{name:'docker_login',ok:true}]}});
  assert.equal(states(vm), 'sandboxes:need docker-account:waits agent:claude-code-subscription:waits agent:codex:waits circle:ok');
  assert.equal(vm.steps[0].detail, 'Not installed.');
  assert.equal(vm.steps.filter(s => s.primary).length, 1);
  assert.equal(vm.lead, 'One step needs you.');
});

test('setupVM: the lead counts the steps that need you (r8 O12)', () => {
  const vm = setup({agents:[{...claude, signedIn:false}, {...codex, signedIn:false}], circle:null});
  const need = vm.steps.filter(s => s.required && (s.state === 'need' || s.state === 'bad'));
  assert.equal(need.length, 2, states(vm));
  assert.equal(vm.lead, 'Two steps need you.');
  // Codex passes its lending checks, so the signed-out Claude row is optional and not counted.
  const pair = setup({agents:[{...claude, signedIn:false}, codex], circle:null});
  assert.equal(pair.steps.find(s => s.id === 'agent:claude-code-subscription').required, false);
  assert.equal(pair.lead, 'One step needs you.');
});

test('setupVM: a missing Docker account is the one action, and the test and agents wait for the Docker sign-in', () => {
  const vm = setup({status:{},readiness:{ready:false, checks:[...okChecks.slice(0, 3), {name:'docker_login',ok:false}]}});
  assert.equal(states(vm), 'sandboxes:ok docker-account:need agent:claude-code-subscription:waits agent:codex:waits circle:ok');
  assert.match(vm.steps[1].detail, /^Not signed in\. Docker Sandboxes needs a free Docker account/);
  assert.deepEqual(vm.steps.filter(s => s.waitsFor).map(s => s.detail), ['Waits for the Docker sign-in.', 'Waits for the Docker sign-in.']);
  assert.doesNotMatch(JSON.stringify(vm), /test run|Test run|Starts a real sandbox/);
});

// A tester, live: Docker's sign-in was reset. The page showed three "needs you" rows, one of them with a shell command, and
// said no agent was signed in. One is real.
test('setupVM: Docker signed out with Codex signed in before gives ONE action, the rest wait, and no command text', () => {
  const tessa = {ready:false, checks:[{name:'sbx_install',ok:true}, {name:'sbx_daemon',ok:true},
    {name:'network_policy',ok:false,label:'The sandbox network policy could not be verified.',remedy:'sbx policy init deny-all (or run: faravan doctor --fix-policy)'}, {name:'docker_login',ok:false}]};
  const vm = setup({readiness:tessa, agents:[{...claude, signedIn:null}, {...codex, signedIn:null, signInState:'Check failed'}]});
  assert.equal(states(vm), 'sandboxes:ok docker-account:need requirement:network_policy:waits agent:claude-code-subscription:waits agent:codex:waits circle:ok');
  assert.equal(vm.steps.filter(s => s.state === 'need' || s.state === 'bad').length, 1, 'one thing needs you');
  assert.deepEqual(vm.steps.filter(s => s.primary).map(s => s.id), ['docker-account']);
  assert.deepEqual(vm.steps.find(s => s.id === 'docker-account').actions, ['docker-signin', 'docker-create', 'recheck']);
  assert.ok(vm.steps.filter(s => s.waitsFor && s.id.startsWith('agent:')).every(s => s.detail === 'Waits for the Docker sign-in.'));
  assert.match(vm.steps.find(s=>s.id==='requirement:network_policy').detail,/after Docker sign-in/);
  const text = JSON.stringify(vm);
  assert.doesNotMatch(text, /sbx policy|faravan doctor|--fix-policy|No coding agent is signed in|could not be verified/);
  assert.equal(vm.headline, 'Lending stopped: sign in to Docker');
});

test('setupVM: Linux remediation remains and Windows feature rows are absent', () => {
  const win = setup({status:{},readiness:{ready:false, checks:[...okChecks.slice(0, 3), {name:'hypervisor_platform',ok:false,label:'Hypervisor Platform is off.'}, okChecks[3]]}});
  assert.doesNotMatch(states(win), /hypervisor/);
  const linux = setup({status:{},readiness:{ready:false, checks:[...okChecks.slice(0, 3), {name:'kvm_access',ok:false,label:'Your user is not in the kvm group.'}, okChecks[3]]}});
  assert.match(states(linux), /sandboxes:ok kvm:need/);
  assert.doesNotMatch(states(setup()), /hypervisor|kvm/);
});

test('setupVM: a signed-out agent is its own row; all signed out is two rows, the first one primary', () => {
  assert.equal(states(setup({agents:[{...claude, signedIn:false}, codex]})), 'sandboxes:ok docker-account:ok agent:claude-code-subscription:need agent:codex:ok circle:ok');
  const none = setup({agents:[{...claude, signedIn:false}, {...codex, signedIn:false}]});
  assert.deepEqual(none.steps.filter(s => s.primary).map(s => s.id), ['agent:claude-code-subscription']);
  assert.equal(none.steps.find(s => s.id === 'agent:codex').detail, 'Signed out.');
});



// U14: the Jobs list and the jump palette.
import {jobsListVM, jobVM, homePageVM, paletteVM, whenLabel, JOB_FILTERS} from './view-models.mjs';
const T = Date.parse('2026-10-19T15:00:00Z');
const ago = ms => new Date(T - ms).toISOString();
const rowsOf = vm => vm.groups.flatMap(g => g.rows);
const listJobs = [
  {job_digest:'sha256:a', role:'sent', status:'Finished', receipt:{harness:'codex'}, local:{title:'Fix the flaky date test', agent:'codex', submittedAt:ago(12 * 60000)}, lenderName:'Mo', circle:{id:'c1', name:'Weekend projects'}},
  {job_digest:'sha256:b', role:'sent', state:'running', status:'Running', current_attempt:{execution_started_at:ago(6 * 60000)}, receipt:{harness:'claude'}, local:{title:'Make the booking form work on phones', agent:'claude', submittedAt:ago(6 * 60000)}, lenderName:'Priya', circle:{id:'c1'}},
  {job_digest:'sha256:c', role:'ran', state:'running', status:'Running', current_attempt:{execution_started_at:ago(4 * 60000)}, local:null, historyIdentity:{localName:'Sam'}, waitingTiming:{submittedAt:ago(4 * 60000)}, circle:{id:'c1'}, title:'Fix the login redirect loop'},
  {job_digest:'sha256:d', role:'sent', status:'Waiting', local:{title:'Add a dark mode switch', submittedAt:ago(26 * 3600000)}, circle:{id:'c1'}},
  {job_digest:'sha256:e', role:'ran', status:'Failed', historyIdentity:{localName:'Sam'}, waitingTiming:{submittedAt:ago(27 * 3600000)}, circle:{id:'c1'}, title:'Speed up the build'},
  {job_digest:'sha256:f', role:'sent', status:'Cancelled', compute_stopped:true, local:{title:'Fix CSV export quotes', submittedAt:ago(9 * 86400000)}, lenderName:'Mo', circle:{id:'c1'}},
];
const view = (over = {}) => jobsListVM(listJobs, {now:T, machine:'Ana’s MacBook', owner:'Ana Ruiz', ...over});

test('jobsListVM groups newest first into Today, Yesterday and Earlier, with absolute dates after a day', () => {
  const vm = view();
  assert.deepEqual(vm.groups.map(g => [g.title, g.rows.length]), [['Today', 3], ['Yesterday', 2], ['Earlier', 1]]);
  assert.deepEqual(rowsOf(vm).map(r => r.when), ['4 min ago', '6 min ago', '12 min ago', 'Oct 18', 'Oct 18', 'Oct 10']);
});

test('jobsListVM: each row has one closed status word, a person and a who-line', () => {
  const rows = rowsOf(view());
  assert.deepEqual(rows.map(r => [r.word, r.kind]), [['Running','run'], ['Working','run'], ['Ready to review','on'], ['Waiting','wait'], ['Didn’t finish','bad'], ['Cancelled','off']]);
  assert.deepEqual(rows.map(r => r.who), ['On Ana’s MacBook · ran for Sam', 'Priya’s Claude Code', 'Mo’s Codex', 'Any agent', 'On Ana’s MacBook · ran for Sam', 'Mo']);
  assert.equal(rows[3].avatar, null, 'your own jobs have no avatar');
  assert.equal(rows[2].href, '#/job/sha256%3Aa/c1');
  assert.equal(rows[0].title, 'Fix the login redirect loop');
  assert.doesNotMatch(JSON.stringify(rows), /Merged|merge/);
});

test('jobsListVM: a lender sees "Sent back", a stop without proof is "Stop requested"', () => {
  assert.equal(rowsOf(jobsListVM([{...listJobs[4], status:'Finished'}], {now:T}))[0].word, 'Sent back');
  assert.equal(rowsOf(jobsListVM([{...listJobs[5], compute_stopped:false, current_attempt:{execution_started_at:ago(10 * 60000),compute_stopped:false}}], {now:T}))[0].word, 'Stop requested');
});

test('jobsListVM filters: sent by me, ran for others, needs you', () => {
  assert.equal(rowsOf(view({filter:'sent'})).every(r => r.role === 'sent'), true);
  assert.equal(rowsOf(view({filter:'ran'})).length, 2);
  assert.deepEqual(rowsOf(view({filter:'needs'})), [], 'a result without confirmed changes does not offer review');
  const known = listJobs.map(job => job.job_digest === 'sha256:a'
    ? {...job, receipt:{...job.receipt, candidate_format:'diff', diffstat:{files:1}}} : job);
  const actionable = jobsListVM(known, {now:T,filter:'needs',jobApprovals:[{jobDigest:'sha256:d',id:'review-d'}]});
  assert.deepEqual(rowsOf(actionable).map(r => r.id), ['sha256:a', 'sha256:d']);
  assert.deepEqual(view({filter:'ran'}).filters.map(f => [f.id, f.on]), JOB_FILTERS.filter(([id])=>id !== 'needs').map(([id]) => [id, id === 'ran']));
  assert.equal(jobsListVM([], {now:T}).count, 0);
});

test('ran job titles prefer the backend title, then local title, then the first nonempty request line', () => {
  const requester = {localName:'Sam'};
  const make = fields => jobVM({role:'ran',historyIdentity:requester,...fields},'ran').title;
  assert.equal(make({title:'Backend title',local:{title:'Local title',prompt:'Request line'}}),'Backend title');
  assert.equal(make({local:{title:'Local title',prompt:'Request line'}}),'Local title');
  assert.equal(make({local:{prompt:'  \n  First request line  \nsecond line'}}),'First request line');
  assert.equal(make({title:'  ',local:{title:'  ',prompt:'\n  Useful request\nMore detail'}}),'Useful request');
  assert.equal(make({prompt:'\u2028  Line after Unicode separator\u2029next'}),'Line after Unicode separator');
  assert.equal(make({prompt:'  \n  Backend request line\nSecond line',local:{prompt:'Local request line'}}),'Backend request line');
  for (const title of ['Untitled job','Coding job','A circle member’s job','A job you ran'])
    assert.equal(make({title,prompt:'Useful request line'}),'Useful request line',title);
  assert.equal(make({}), 'Job for Sam');
  assert.equal(jobVM({role:'ran'},'ran').title, 'A job you ran');
  const long = '😀'.repeat(121);
  assert.equal(Array.from(make({title:long})).length,120);
  assert.equal(make({title:long}), '😀'.repeat(120));
});

test('jobVM marks no changes only from explicit zero-file result metadata', () => {
  const ready = fields => jobVM({job_digest:'result',role:'sent',state:'result-accepted',...fields},'sent');
  const receipt = ready({receipt:{candidate_format:'diff',diffstat:{files:0}}});
  assert.deepEqual([receipt.noChanges,receipt.resultPending,receipt.word,receipt.listWord,receipt.kind],
    [true,false,'No changes','No changes','off']);
  assert.equal(ready({receipt:{diffstat:{files:0}}}).noChanges,true,'older receipt without format remains usable');
  assert.equal(ready({diffstat:{files:0}}).noChanges,true,'API diffstat is explicit evidence');
  assert.equal(ready({}).resultPending,true,'missing count remains unknown');
  assert.equal(ready({receipt:{candidate_format:'tree',diffstat:{files:0}}}).resultPending,true,
    'a tree receipt cannot establish an empty diff');
  assert.equal(ready({receipt:{candidate_format:'diff',diffstat:{files:2}}}).resultPending,false);
  const loaded = jobVM({job_digest:'result',role:'sent',state:'result-accepted'},'sent',
    {changes:{format:'diff',files:[],invalid:false}});
  assert.deepEqual([loaded.noChanges,loaded.resultPending],[true,false]);
  const invalid = jobVM({job_digest:'result',role:'sent',state:'result-accepted'},'sent',
    {changes:{format:'diff',files:[],invalid:true}});
  assert.deepEqual([invalid.noChanges,invalid.resultPending],[false,true]);
  const invalidWithEmptyReceipt = ready({receipt:{candidate_format:'diff',diffstat:{files:0}}});
  const invalidLoaded = jobVM({job_digest:'result',role:'sent',state:'result-accepted',receipt:{candidate_format:'diff',diffstat:{files:0}}},'sent',
    {changes:{format:'diff',files:[],invalid:true}});
  assert.deepEqual([invalidWithEmptyReceipt.noChanges,invalidLoaded.noChanges,invalidLoaded.resultPending],[true,false,true],
    'a loaded invalid result overrides older empty receipt metadata');
  const unsupportedLoaded = jobVM({job_digest:'result',role:'sent',state:'result-accepted',receipt:{candidate_format:'diff',diffstat:{files:0}}},'sent',
    {changes:{format:'tree',files:[]}});
  assert.deepEqual([unsupportedLoaded.noChanges,unsupportedLoaded.resultPending],[false,true]);
  assert.equal(ready({receipt:{candidate_format:'tree',diffstat:{files:0}},diffstat:{files:3}}).resultPending,false,
    'top-level current diffstat takes precedence over an incompatible older receipt');
  const failed = jobVM({state:'failed',receipt:{candidate_format:'diff',diffstat:{files:0}}},'sent');
  assert.deepEqual([failed.noChanges,failed.resultPending],[false,false],'only a finished result has this classification');
  const ran = jobVM({state:'result-accepted',role:'ran',receipt:{diffstat:{files:0}}},'ran');
  assert.deepEqual([ran.noChanges,ran.listWord,ran.kind],[true,'No changes','off']);
});

test('no-change results leave Home review attention and Jobs needs filters but remain in recent history', () => {
  const empty = {job_digest:'empty',role:'sent',state:'result-accepted',receipt:{candidate_format:'diff',diffstat:{files:0}}};
  const unknown = {job_digest:'unknown',role:'sent',state:'result-accepted'};
  const rows = rowsOf(jobsListVM([empty,unknown],{now:T,needsDigests:['empty']}));
  const emptyRow = rows.find(row => row.id === 'empty'), unknownRow = rows.find(row => row.id === 'unknown');
  assert.deepEqual([emptyRow.noChanges,emptyRow.resultPending,emptyRow.needs,emptyRow.word,emptyRow.kind],
    [true,false,false,'No changes','off']);
  assert.deepEqual([unknownRow.noChanges,unknownRow.resultPending,unknownRow.needs],[false,true,false]);
  assert.equal(needsYouCount({jobs:[empty],approvals:[],home:{}}),0);
  assert.equal(needsYouCount({jobs:[unknown],approvals:[],home:{}}),1);
  for (const field of ['needs_you','attention']) {
    assert.equal(needsYouCount({jobs:[empty],approvals:[],home:{[field]:[{kind:'result',job_digest:'empty'}]}}),0,
      field + ' cannot reintroduce a known empty result');
  }
  assert.equal(needsYouCount({jobs:[empty],approvals:[],home:{needs_you:[
    {kind:'result',job_digest:'empty'},{kind:'request',id:'empty'}]}}),1,
    'filter only the result item; an approval with the same digest remains');
  assert.equal(needsYouCount({jobs:[empty],approvals:[],home:{needs_you:[
    {kind:'result',job_digest:'empty',job:{job_digest:'empty',state:'queued'}}]}}),0,
    'the loaded job row overrides a stale embedded waiting record');
  const home = homePageVM({jobs:[empty],approvals:[],home:{},now:T});
  assert.deepEqual([home.counts.results,home.result,home.recent[0].noChanges,home.recent[0].word],
    [0,null,true,'No changes']);
});

test('jobPageVM uses loaded empty diff metadata and keeps unknown counts pending', () => {
  const job = {job_digest:'page',state:'result-accepted',status:'Finished',canSetBorrowerOutcome:true};
  const empty = jobPageVM(job,{format:'diff',files:[],invalid:false},{role:'borrower'});
  const unknown = jobPageVM(job,{}, {role:'borrower'});
  assert.deepEqual([empty.noChanges,empty.resultPending],[true,false]);
  assert.deepEqual([unknown.noChanges,unknown.resultPending],[false,true]);
});

test('Home, Jobs and jobVM share the ran identity, title, laptop glyph and recorded agent', () => {
  const job = {job_digest:'same',role:'ran',state:'result-accepted',title:'Parser repair',
    historyIdentity:{localName:'Sam'},agent:'codex',created_at:ago(60000)};
  const identity = jobVM(job,'ran',{now:T}), row = rowsOf(jobsListVM([job],{now:T}))[0];
  const home = homePageVM({jobs:[job],approvals:[],home:{},now:T}).recent[0];
  assert.deepEqual([identity.title,identity.glyph,identity.agent],[row.title,row.glyph,row.agent]);
  assert.deepEqual([home.title,home.glyph,home.agent],[identity.title,identity.glyph,identity.agent]);
  assert.equal(identity.word,'Sent back');
  assert.deepEqual([home.word,row.word],[identity.word,identity.word]);
});

test('a roster name fills the same ran identity when history has only its author key', () => {
  const job={job_digest:'roster-name',role:'ran',state:'result-accepted',title:'',circle:{id:'circle-1'},historyIdentity:{author:'key-sam'}};
  const devices={circles:[{circle:'circle-1',members:[{keyId:'key-sam',localName:{label:'Sam'}}]}]};
  const direct=jobVM(job,'ran',{devices});
  const row=rowsOf(jobsListVM([job],{now:T,devices}))[0];
  const home=homePageVM({jobs:[job],approvals:[],home:{},devices,now:T}).recent[0];
  assert.deepEqual([direct.title,direct.requester],["Job for Sam","Sam"]);
  assert.deepEqual([row.title,row.person.name],[direct.title,direct.requester]);
  assert.deepEqual([home.title,home.person.name],[direct.title,direct.requester]);
});

test('jobs group by the computer calendar even when configured zone is UTC', () => {
  const oldTZ = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const now=Date.parse('2026-10-20T05:10:00Z');
    const job=(id, submittedAt)=>({job_digest:id,role:'sent',state:'queued',local:{title:id,submittedAt}});
    const utcMidnight = jobsListVM([
      job('late-utc-yesterday','2026-10-20T00:30:00Z'),
      job('early-utc-yesterday','2026-10-19T23:30:00Z')
    ],{now,zone:'UTC'});
    assert.deepEqual(utcMidnight.groups.map(group=>group.title),['Yesterday']);

    const chicagoMidnight = jobsListVM([
      job('chicago-today','2026-10-20T05:03:45Z'),
      job('chicago-yesterday','2026-10-20T04:48:39Z')
    ],{now,zone:'UTC'});
    assert.deepEqual(chicagoMidnight.groups.map(group=>group.title),['Today','Yesterday']);
  } finally {
    if (oldTZ === undefined) delete process.env.TZ;
    else process.env.TZ = oldTZ;
  }
});

test('agent identity needs actual evidence except for a requested agent on waiting jobs', () => {
  const vm = (fields, role = 'ran') => jobVM({role,...fields},role).agent;
  assert.equal(vm({receipt:{harness:'claude'},local:{agent:'codex'}}),'Claude Code');
  assert.equal(vm({receipt:{harness:' '},agent:'gemini',local:{agent:'codex'}}),'Gemini');
  assert.equal(vm({agent:'gemini',local:{agent:'codex'}}),'Gemini');
  assert.equal(vm({state:'result-accepted',resultSummary:{receipt:{receipt:{harness:'claude-code-subscription'}}}}),'Claude Code');
  assert.equal(vm({state:'queued',local:{agent:'codex'}}),'Codex');
  assert.equal(vm({state:'queued',harness:'codex'}),'Codex');
  assert.equal(vm({state:'claimed',approval:'pending',local:{agent:'codex'}}),'Codex');
  assert.equal(vm({state:'claimed'}),'Any agent');
  assert.equal(vm({state:'queued',local:{agent:'bogus'}}),'Agent not recorded');
  assert.equal(vm({state:'queued'}),'Any agent');
  assert.equal(vm({state:'result-accepted',local:{agent:'codex'}}),'Codex (requested)');
  assert.equal(vm({state:'failed',harness:'codex'}),'Codex (requested)');
  assert.equal(vm({state:'result-accepted'}),'Agent not recorded');
  assert.equal(vm({state:'running'}),'Any agent');
  assert.equal(vm({state:'running',agent:'unknown-agent'}),'Agent not recorded');
  assert.equal(vm({state:'running'},'sent'),'Any agent');
  assert.equal(vm({state:'queued'},'sent'),'Any agent');
});

test('whenLabel is relative under a day and absolute after', () => {
  assert.deepEqual([30000, 90000, 3 * 3600000, 25 * 3600000].map(ms => whenLabel(T - ms, T)), ['just now', '1 min ago', '3 h ago', 'Oct 18']);
  assert.equal(whenLabel('nonsense', T), '');
});

const people = [{id:'c1:k', name:'Sam Okafor', circle:'Weekend projects', href:'#/circle/c1'}];
const palJobs = rowsOf(view());
const approvals = [{id:'r1', requesterName:'Sam', requester:'k', prompt:'The login page loops back to itself after the Google sign-in. Find why and fix it.'}];

test('paletteVM: navigation, recent five jobs, circles and actions', () => {
  const jobs = Array.from({length:7},(_,i)=>({id:String(i),title:'Fix parser '+i,at:i,href:'#/job/'+i}));
  const vm = paletteVM('', {jobs, circles:[{id:'friends',name:'Friends',origin:'http://fixture'}],lendingOn:true});
  assert.deepEqual(vm.sections.map(s=>s.title), ['Go to','Jobs','Circles','Actions']);
  assert.deepEqual(vm.sections[0].items.map(i=>i.label), ['Home','Jobs','Lending','What you lend','Circles','Setup','You','Settings']);
  assert.deepEqual(vm.sections[1].items.map(i=>i.id), ['job:6','job:5','job:4','job:3','job:2']);
  assert.equal(paletteVM('lend').items[0].href, '#/lend');
  assert.equal(paletteVM('fxprsr', {jobs}).sections[0].title, 'Jobs');
  assert.equal(paletteVM('Friends',{circles:[{id:'a/b',name:'Friends',origin:'http://fixture'}]}).items[0].href, '#/circle/a%2Fb');
  assert.equal(paletteVM('zzzz').items.length, 0);
});
test('paletteVM: pause is an explicit action only while lending is on', () => {
  assert.equal(paletteVM('pause', {lendingOn:false}).items.filter(i => i.op).length, 0);
  assert.equal(paletteVM('pause', {lendingOn:false}).items[0].id, 'setting:lending.enabled', 'the setting is still findable');
  assert.equal(paletteVM('pause', {lendingOn:true}).items[0].op, 'lending.pause');
});
test('palette request avatars use local person names, never requester devices', () => {
  const item = card => paletteVM('', {approvals:[card]}).items.find(row => row.id === 'need:r1');
  assert.equal(item({id:'r1',localName:'Sam Ruiz',requesterName:'Sam laptop'}).avatarName,'Sam Ruiz');
  assert.equal(item({id:'r1',requesterName:'Sam laptop'}).avatarName,'');
});

// U20: setup states beyond the happy path.
const bad = (name, extra = {}) => ({name, ok:false, ...extra});
const sbx = {name:'sbx_install', ok:true};
test('setupVM: Linux kvm gives the whole command to run, including the step after it', () => {
  const vm = setup({readiness:{ready:false, checks:[sbx, {name:'sbx_daemon', ok:true}, bad('kvm_access', {remedy:'sudo usermod -aG kvm $USER && newgrp kvm (on a VM, also enable nested virtualization)'}), {name:'docker_login', ok:true}]}});
  const kvm = vm.steps.find(s => s.id === 'kvm');
  assert.deepEqual([kvm.state, kvm.command, kvm.actions], ['need', 'sudo usermod -aG kvm $USER && newgrp kvm (on a VM, also enable nested virtualization)', ['recheck']]);
  assert.equal(kvm.detail, 'Your user needs to be in the kvm group. Run this, then log out and back in.');
});

test('setupVM: the Docker account step offers sign-in, account creation and a re-check', () => {
  const step = setup({readiness:{ready:false, checks:[sbx, {name:'sbx_daemon', ok:true}, bad('docker_login')]}}).steps.find(s => s.id === 'docker-account');
  assert.deepEqual(step.actions, ['docker-signin', 'docker-create', 'recheck']);
  assert.ok(step.detail.includes('Docker uses this account to download sandbox images. This setup check does not verify what Docker software or services can access or record. Review Docker’s applicable data handling before using sensitive material.'));
  assert.doesNotMatch(step.detail,/doesn’t see your jobs/);
});



test('setupVM: an agent that is not installed is named, with install help', () => {
  const vm = setup({agents:[{id:'claude-code-subscription', useForLending:true, installed:false, signedIn:null}, {id:'codex', useForLending:true, installed:false}]});
  const claudeRow = vm.steps.find(s => s.id === 'agent:claude-code-subscription');
  assert.equal(claudeRow.state, 'need');
  assert.equal(claudeRow.detail, 'Not installed.');
  assert.deepEqual(claudeRow.install.map(a => a.name), ['Claude Code']);
});

test('setupVM: an unsupported computer is told why and what still works', () => {
  const mac = setupVM({status:{desktop:{platform:'macos', lendable:false}}, devices:{name:'Ana’s MacBook Pro'}});
  assert.deepEqual([mac.kind, mac.headline], ['unsupported', 'This Mac can’t lend']);
  assert.match(mac.lead, /This Mac does not currently meet the lending requirements\.$/);
  assert.doesNotMatch(mac.lead, /Intel/);
  assert.match(mac.lead, /Apple silicon Macs \(M1 or newer\) and Ubuntu 24\.04 or later/);
  assert.deepEqual(mac.card.action, {label:'Open Circles', href:'#/circles'}, 'no circle yet, so no send promise');
  assert.match(mac.card.text, /^Join or start a circle first\. Once your membership is approved, you can send jobs/, 'what still works, once they are in a circle');
  assert.equal(setupVM({status:{reason:'platform_unsupported',desktop:{platform:'linux'}}}).headline, 'This computer can’t lend');
});

test('setupVM: Windows is unsupported regardless of pin prompt', () => {
  for (const pinPrompt of [true, false]) {
    const vm = setupVM({status:{desktop:{platform:'windows', pinPrompt}},readiness:{ready:true,checks:okChecks}});
    assert.equal(vm.kind, 'unsupported');
    assert.doesNotMatch(vm.lead, /Windows 11/);
  }
});

// U3 follow-up: Pause new jobs and today's counters from the API.
import {pauseChoices} from './view-models.mjs';
test('pauseChoices: one hour, tomorrow at 7 AM local, or until you resume', () => {
  const t = new Date(2026, 9, 19, 16, 0, 0).getTime();
  const [hour, tomorrow, resume] = pauseChoices(t);
  assert.deepEqual([hour.label, hour.until], ['For 1 hour', t + 3600000]);
  assert.deepEqual([tomorrow.label, tomorrow.until], ['Until tomorrow, 7 AM', new Date(2026, 9, 20, 7, 0, 0).getTime()]);
  assert.deepEqual([resume.label, resume.until], ['Until I resume', null]);
  assert.ok(tomorrow.until - t < 7 * 86400000, 'the API accepts at most 7 days');
});

test('lendPageVM: no duplicate pause action is offered in any intent or execution state', () => {
  const can = (top, lending = {}) => page(top, lending).canPause;
  assert.deepEqual([can({state:'ready'}), can({state:'outside'}), can({state:'off'}, {enabled:false}), can({state:'paused'}), can({state:'running'}), can({state:'resting', reason:'daily_limit'})],
    [true, true, false, false, true, false], 'timed pause remains available for active lending');
  assert.equal(lendPageVM({state:'ready',needs_you:[{kind:'agent_signed_out',agent:'codex'}],lending:{enabled:true}}, {agents:[claude, codex],readiness:{ready:true,checks:[]}, now}).canPause, true);
});

test('lendPageVM: the API’s `today` counters drive the jobs meter', () => {
  const vm = lendPageVM({state:'ready', today:{jobs:2, jobLimit:3, minutes:20, minuteLimit:60}, lending:{enabled:true}}, {now});
  assert.deepEqual(vm.meters.map(m => [m.label, m.value, m.of]), [['Jobs today', '2', 'of 3'], ['Minutes today','20','of 60']]);
});

// Vocabulary port (vocab.mjs): one closed set of status words.
import {JOB_STATES, STEP_OF, JOB_STEPS, jobStateKey, jobStateView} from './view-models.mjs';
test('every vocab state has a word, a colour and a step entry; unknown states never show a code', () => {
  for (const [key, entry] of Object.entries(JOB_STATES)) {
    assert.ok(entry.word && ['wait', 'run', 'on', 'off', 'bad'].includes(entry.kind), key);
    assert.ok(key in STEP_OF, 'STEP_OF lacks ' + key);
  }
  assert.deepEqual(JOB_STEPS, ['Asked', 'Approved', 'Working', 'Ready']);
  assert.equal(jobStateView({status:'Something new'}).word, 'Status unavailable');
  assert.doesNotMatch(Object.values(JOB_STATES).map(s => s.word).join('|'), /\bDone\b|Merged|Finished/);
});
test('jobStateKey maps what the API says today, and only that', () => {
  const key = (status, extra = {}) => jobStateKey({status, ...extra});
  assert.deepEqual([key('Waiting'), key('queued'), jobStateKey({state:'claimed',approval:'pending'}),
    jobStateKey({state:'running',current_attempt:{execution_started_at:'2026-10-19T18:54:00Z'}}), key('Finished'), key('failed'), key('expired')],
    ['waiting', 'waiting', 'waiting_approval', 'working', 'ready', 'failed', 'expired']);
  assert.equal(key('running', {executionProof:false}), 'waiting');
  assert.equal(key('cancelled', {current_attempt:null}), 'cancelled');
  assert.equal(key('cancelled'), 'stop_requested', 'without attempt evidence a cancellation is not proven to have happened before a start');
  assert.equal(key('cancelled', {compute_stopped:true}), 'cancelled');
});

// The real API row has the coordinator's `state` and a `status` label that says "Starting" for every claimed job.
test('jobStateKey reads approval and execution evidence for claimed jobs', () => {
  const real = (state, extra = {}) => jobStateKey({state, status: {queued: 'Waiting', claimed: 'Starting', cancelled: 'Cancelled'}[state] ?? state, ...extra});
  assert.equal(real('claimed', {approval:'pending',current_attempt: {holder: 'k', execution_started_at: null}}), 'waiting_approval');
  assert.equal(real('claimed', {current_attempt: {holder: 'k', approved_at:'2026-10-19T18:53:00Z'}}), 'approved');
  assert.equal(real('claimed', {approval:'pending',current_attempt: {holder: 'k', approved_at:'not-a-time'}}), 'waiting_approval');
  assert.equal(real('claimed', {current_attempt: {holder: 'k', execution_started_at: '2026-10-19T18:54:00Z'}}), 'working', 'the label says Starting; the attempt says it runs');
  assert.equal(real('claimed', {current_attempt: {holder: 'k', approved_at:'2026-10-19T18:53:00Z', execution_started_at:'2026-10-19T18:54:00Z'}}), 'working', 'execution proves the agent started');
  assert.equal(real('cancelled', {current_attempt:null}), 'cancelled', 'cancelled before any claim');
  assert.equal(real('cancelled', {current_attempt: {compute_stopped: false}}), 'stop_requested');
  assert.equal(real('cancelled', {current_attempt: {compute_stopped: true}}), 'stopped');
  assert.deepEqual([jobStateKey({status:'Starting'}), jobStateKey({state:'starting',approval:'approved',status:'Starting'}),
    jobStateKey({status:'Stop requested'})], ['waiting', 'starting', 'stop_requested']);
});

test('lendPageVM reads S1.1b: intent and execution, never hiding a running job', () => {
  const vm = lendPageVM(withLendingProjection({intent:{on:true,state:'paused', reason:'paused', until:pausedUntil},execution:{state:'finishing', job:'sha256:a', person:'Sam', stops_by:pausedUntil},lending:{enabled:true, limits:{timeZone:'UTC'}}}, {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused',execution:'finishing',executionJob:'sha256:a'}), {agents:[claude, codex], now});
  assert.deepEqual(row(vm), ['running', 'Finishing Sam’s job', 'Paused until '+localClock(pausedUntil)+'. No new jobs start.']);
  assert.equal(vm.exec.text, 'Sam’s job is finishing · time limit: '+localClock(pausedUntil));
  const running = lendPageVM(withLendingProjection({intent:{on:true,state:'ready'},execution:{state:'running', job:'sha256:b', person:'Sam'},lending:{enabled:true}}, {intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'sha256:b'}), {agents:[claude, codex], readiness:{ready:true,checks:[]}, now});
  assert.deepEqual([running.kind, running.headline, running.exec.text], ['running', 'Running Sam’s job', 'Sam’s job is running']);
  const stopping = lendPageVM(withLendingProjection({intent:{on:false,state:'off'},execution:{state:'stopping', job:'sha256:c', person:'Sam'},lending:{enabled:false}}, {intent:'off',intentState:'off',admission:'blocked',admissionReason:'off',execution:'stopping',executionJob:'sha256:c'}), {now});
  assert.deepEqual([stopping.exec.text, stopping.exec.canStop], ['Stopping Sam’s job…', false]);
  assert.equal(lendPageVM(withLendingProjection({intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{enabled:true}}, {intent:'on',intentState:'ready',admission:'allowed'}), {agents:[claude, codex], now}).exec, null);
});

// What blocks lending: the ported blockers.mjs (its own 7,708-case test is blockers-model.test.mjs); these test the adapter.
import {blockersInput, blockersFor} from './view-models.mjs';
const claudeUnchecked = {id:'claude-code-subscription', useForLending:true, installed:true, signedIn:null};
const codexFailed = {id:'codex', useForLending:true, installed:true, signedIn:true, signInState:'Check failed'};
const dockerOut = {ready:false, checks:[{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:false}]};

test('blockersFor: Docker signed out (Tessa’s case) is the one fix, the test and both agents wait, no "safety" wording', () => {
  const bl = blockersFor({status:{intent:{state:'ready'},lending:{enabled:true}}, readiness:dockerOut, agents:[claudeUnchecked, codexFailed]});
  assert.equal(bl.headline, 'Lending stopped: sign in to Docker');
  assert.deepEqual(bl.needsYou.map(i => i.action), ['Sign in to Docker']);
  assert.deepEqual(bl.items.filter(i => i.agent).map(i => [i.agent, i.status, i.detail]), [['claude-code-subscription', 'waits', 'Waits for the Docker sign-in.'], ['codex', 'waits', 'Waits for the Docker sign-in.']]);
  assert.equal(bl.waits, 'Claude Code and Codex wait for the Docker sign-in.');
  assert.equal(bl.active, true);
  assert.equal(bl.steps, 3, 'sign-in and the two agents are not done');
  assert.ok(!/safety check failed/i.test(JSON.stringify(bl)));
});

test('blockersInput: an expired Docker sign-in names its time when the API gives one; the backend reason alone still blocks', () => {
  const withTime = blockersFor({status:{lending:{enabled:true}}, readiness:{...dockerOut, docker:{expired_at:'2026-10-19T18:52:00Z'}}, agents:[claudeUnchecked], zone:'UTC'});
  assert.equal(withTime.headline, 'Lending stopped: your Docker sign-in expired');
  assert.equal(withTime.first.detail, 'Expired at 6:52 PM.');
  for (const status of [{reason:'docker_signed_out'}, {intent:{state:'blocked', reason:'docker_signed_out'}}, {needs_you:[{kind:'docker_signed_out'}]}])
    assert.equal(blockersFor({status:{...status,lending:{enabled:true}}, readiness:null, agents:[]}).first.key, 'docker_signin', JSON.stringify(status));
});







test('blockersInput: lending off, paused, outside hours and resting are the intent, and an intent blocker is not a fault', () => {
  const ok = {ready:true, checks:[]}, one = [{id:'codex', useForLending:true, installed:true, signedIn:true}];
  const head = status => blockersFor({status:{...status}, readiness:ok, agents:one, zone:'UTC', now:now-60_000});
  assert.equal(head({intent:{state:'off'}, lending:{enabled:false}}).headline, 'Lending is off');
  assert.equal(head({intent:{state:'paused', until:Date.parse('2026-10-19T15:00:00Z')}, lending:{enabled:true}}).headline, 'Paused until 3:00 PM');
  assert.equal(head({intent:{state:'paused'}, lending:{enabled:true}}).headline, 'Paused until you resume');
  assert.equal(head({intent:{state:'resting'}, lending:{enabled:true}}).headline, 'Resting until midnight');
  assert.equal(head({intent:{state:'off'}, lending:{enabled:false}}).active, false, 'Home does not list "Lending is off" as a fault');
});

test('lendPageVM: a blocker keeps the switch on and headlines the model, never "a safety check failed"', () => {
  const home=withLendingProjection({intent:{on:true,state:'blocked',reason:'docker_signed_out'},lending:{enabled:true}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});
  const vm = lendPageVM(home, {agents:[claudeUnchecked, codexFailed], readiness:dockerOut, now});
  assert.deepEqual([vm.kind, vm.headline, vm.switch.on], ['blocked', 'Lending stopped: sign in to Docker', true]);
  assert.equal(vm.reason, 'Not signed in.');
  assert.equal(vm.heroAction?.action, 'Sign in to Docker');
  assert.equal(vm.canPause, false);
});

test('lendPageVM: inconclusive Docker sign-in offers a check rather than sign-in', () => {
  const readiness = {...dockerOut, checks: dockerOut.checks.map(row => row.name === 'docker_login'
    ? {...row, unknown:true, cause:'docker_signin_refresh_unavailable'} : row)};
  const home = withLendingProjection({lending:{enabled:true}},
    {intent:'on', intentState:'blocked', admission:'blocked', admissionReason:'docker_signed_out'});
  const vm = lendPageVM(home, {agents:[claudeUnchecked, codexFailed], readiness, now});
  const signIn = vm.blockers.items.find(item => item.key === 'docker_signin');
  assert.equal(vm.headline, 'Checking Docker sign-in');
  assert.deepEqual([signIn.status, signIn.action], ['unknown', 'Check again']);
  assert.ok(vm.blockers.needsYou.every(item => item.action !== 'Sign in to Docker'));
});

test('setupVM: unknown lending status takes precedence over the Docker sign-in headline', () => {
  const status = withLendingProjection({}, {intent:'unknown', intentState:null, admission:'unknown', admissionReason:null, execution:'unknown'});
  const vm = setup({status, readiness:dockerOut});
  assert.equal(vm.intentUnknown, true);
  assert.equal(vm.headline, 'Lending status unavailable');
  assert.notEqual(vm.lead, 'Not signed in.');
  assert.ok(vm.steps.find(s => s.id === 'docker-account').actions.includes('docker-signin'));
});

// The safety sentences are safety-copy.mjs, ported unchanged; its 459,201-case totality test is safety-copy.test.mjs.

// U6: the job page's words per state, from what the API gives today.
import {jobStatusVM, howItRanVM, waitingCopyVM, requestTimingVM} from './view-models.mjs';

test('an anonymous modern decline is visible to the requester',()=>{
  const copy=waitingCopyVM({state:'queued',declined_count:1},{zone:'UTC'});
  assert.match(copy.previousDecision,/A lender declined/);
});
const T0 = Date.parse('2026-10-19T19:00:00Z');
const ctxJob = {now: T0, zone: 'UTC', lender: 'Ana', agent: 'Codex', progress: []};
const entries = [{seq: 1, at: '2026-10-19T18:54:00Z', stage: 'preparing', elapsed_s: 0}, {seq: 2, at: '2026-10-19T18:54:40Z', stage: 'agent', elapsed_s: 40},
  {seq: 3, at: '2026-10-19T18:56:00Z', step: 'Reading a file', kind: 'step'}, {seq: 4, at: '2026-10-19T18:58:00Z', step: 'Editing src/booking/save.ts', kind: 'step'}];
const started = {holder: 'k', state: 'active', execution_started_at: '2026-10-19T18:54:00Z'};

test('jobStatusVM: working names who, how long, and the stages and step their computer reported', () => {
  const vm = jobStatusVM({state: 'claimed', status: 'Starting', current_attempt: started}, {...ctxJob, device: 'Ana’s MacBook', progress: entries});
  assert.deepEqual([vm.pill.word, vm.step, vm.headline, vm.facts], ['Working', 2, 'Ana’s Codex is working on it', ['On Ana’s MacBook', 'Started 6:54 PM (6 min ago)']]);
  assert.doesNotMatch(vm.facts.join(' · '), /just now|running/, 'recorded start age is not proof of current execution');
  assert.deepEqual(vm.progress, [{tone: 'ok', text: 'Prepared the sandbox · 0:40'}, {tone: 'now', text: 'Agent working · 6 min · editing src/booking/save.ts'}]);
  assert.equal(vm.note, 'Progress reported by Ana’s computer.');
  assert.deepEqual([vm.canStop, vm.stopLabel], [true, 'Stop this job']);
  assert.ok(!/notify/i.test(JSON.stringify(vm)), 'no promise of a notification the app does not send');
});

test('jobStatusVM: progress rows follow the stage; an older lender with only steps still shows the latest step', () => {
  const rows = (progress) => jobStatusVM({state: 'claimed', current_attempt: started}, {...ctxJob, progress}).progress;
  assert.deepEqual(rows(entries.slice(0, 1)), [{tone: 'now', text: 'Preparing the sandbox'}]);
  assert.deepEqual(rows([...entries, {seq: 5, at: 'x', stage: 'sending', elapsed_s: 540}]), [{tone: 'ok', text: 'Prepared the sandbox · 0:40'}, {tone: 'ok', text: 'Agent finished'}, {tone: 'now', text: 'Sending the result'}]);
  assert.deepEqual(rows(entries.slice(2)), [{tone: 'now', text: 'Agent working · 6 min · editing src/booking/save.ts'}]);
  assert.equal(rows([])[0].text, 'Agent working · 6 min');
  assert.equal(rows(undefined)[0].tone, 'now');
});

test('jobStatusVM: the status line uses the job cap and transcript output time', () => {
  const vm = jobStatusVM({state:'claimed',current_attempt:started,runTiming:{hardStopAt:'2026-10-19T19:14:00Z'}},
    {...ctxJob,now:T0+300000,lastOutputAt:T0+120000});
  assert.deepEqual(vm.facts, ['Started 6:54 PM (11 min ago) · Time limit 7:14 PM · Last visible output 3 min ago']);
});

test('jobStatusVM: the transcript feed names the step the agent is on, with the command apart for monospace', () => {
  const vm = jobStatusVM({state: 'claimed', current_attempt: started}, {...ctxJob, progress: entries, activity: {doing: 'running', code: 'cd /tmp && python render.py'}});
  assert.deepEqual(vm.progress.at(-1), {tone: 'now', text: 'Agent working · running', code: 'cd /tmp && python render.py'});
  const fresh = jobStatusVM({state: 'claimed', current_attempt: {...started, execution_started_at: '2026-10-19T19:00:00Z'}}, {...ctxJob, activity: {doing: 'edited', code: 'sum.mjs'}});
  assert.deepEqual([fresh.facts, fresh.progress.at(-1).text], [['Started 7:00 PM (0 s ago)'], 'Agent working · edited']);
});

test('jobStatusVM: a name or fact it does not have is left out, never invented', () => {
  const vm = jobStatusVM({state: 'claimed', approval:'pending', status: 'Starting', current_attempt: {...started, execution_started_at: undefined}}, {now: T0});
  assert.equal(vm.key, 'waiting_approval');
  assert.equal(vm.headline, 'Waiting for a lender to say yes');
  const anon = jobStatusVM({state: 'claimed', status: 'Running', current_attempt: started}, {now: T0});
  assert.deepEqual([anon.headline, anon.note, anon.progress.map(p => p.text)], ['An agent is working on it', '', ['Agent working · 6 min']]);
});

test('claimed jobs distinguish a lender decision from an approved run', () => {
  const waiting = {state:'claimed',approval:'pending',current_attempt:{claimed_at:'2026-10-19T18:50:00Z'}};
  const approved = {state:'claimed',current_attempt:{claimed_at:'2026-10-19T18:50:00Z',approved_at:'2026-10-19T18:53:00Z'}};
  const running = {state:'claimed',current_attempt:{claimed_at:'2026-10-19T18:50:00Z',execution_started_at:'2026-10-19T18:54:00Z'}};
  const waitingVM = jobStatusVM(waiting,{now:T0,lender:'Ana'});
  assert.deepEqual([waitingVM.key,waitingVM.pill.word,waitingVM.step,waitingVM.headline],['waiting_approval','Waiting for an answer',0,'Waiting for Ana to say yes']);
  assert.deepEqual([jobStatusVM(approved,{now:T0}).key,jobStatusVM(approved,{now:T0}).pill.word,jobStatusVM(approved,{now:T0}).step],['approved','Approved',1]);
  assert.equal(jobStatusVM(running,{now:T0}).key,'working');
  assert.doesNotMatch(JSON.stringify(waitingVM),/claimed/i);
  const row = rowsOf(jobsListVM([{job_digest:'awaiting',role:'sent',...waiting}],{now:T0}))[0];
  const home = homePageVM({jobs:[{job_digest:'awaiting',role:'sent',...waiting}],approvals:[],home:{},now:T0});
  assert.deepEqual([row.key,row.word,row.step],["waiting_approval","Waiting for an answer",0]);
  assert.equal(home.inMotion[0].key,'waiting_approval');
});

test('jobStatusVM does not show a new-shape attempt as running before execution is observed', () => {
  const vm = jobStatusVM({state:'claimed',approval:'approved',current_attempt:{
    claimed_at:'2026-10-19T18:50:00Z',approved_at:'2026-10-19T18:53:00Z',
    execution_started_at:'2026-10-19T18:54:00Z',execution_observed_at:null,
  }},{now:T0});
  assert.equal(vm.key,'approved');
  assert.equal(vm.pill.word,'Approved');
});

test('jobStatusVM: a stop is "requested" until the lender’s computer confirms it; before a start it is only "cancelled"', () => {
  const requested = jobStatusVM({state: 'cancelled', status: 'Cancelled', current_attempt: started}, {...ctxJob, now: T0});
  assert.deepEqual([requested.key, requested.pill.word, requested.headline], ['stop_requested', 'Stop requested', 'You asked Ana’s computer to stop']);
  assert.match(requested.text, /It hasn’t confirmed yet\. Until it does, the agent may still be working\./);
  const stopped = jobStatusVM({state: 'cancelled', status: 'Cancelled', compute_stopped: true, current_attempt: started}, ctxJob);
  assert.deepEqual([stopped.key, stopped.headline, stopped.fail, stopped.text], ['stopped', 'Stopped', true, 'Ana’s computer confirmed that the sandbox stopped. The agent’s changes up to the stop weren’t kept. Ana’s computer may still hold a copy of your code until it cleans up.']);
  const never = jobStatusVM({state: 'cancelled', status: 'Cancelled', compute_stopped: true}, ctxJob);
  assert.deepEqual([never.key, never.headline, never.text], ['cancelled', 'You cancelled this job before it started', 'Nothing ran.']);
  assert.equal(jobStatusVM({state: 'cancelled', compute_stopped: true}, {...ctxJob, role: 'ran'}).headline, 'This job was cancelled before it started');
});

test('jobStatusVM: failed, expired and unknown never show a raw code or promise what is not known', () => {
  assert.deepEqual([jobStatusVM({state: 'failed'}, ctxJob).pill.word, jobStatusVM({state: 'failed'}, ctxJob).headline, jobStatusVM({state: 'failed'}, ctxJob).step], ['Didn’t finish', 'The job didn’t finish', 2]);
  const expired = jobStatusVM({state: 'expired', waitingTiming: {submittedAt: '2026-10-18T19:00:00Z', expiresAt: '2026-10-19T18:00:00Z'}}, ctxJob);
  assert.deepEqual([expired.headline, expired.text, expired.step], ['Nobody took it within 23 hours', 'No agent started on it. It expired at 6:00 PM.', null]);
  assert.equal(jobStatusVM({state: 'expired'}, ctxJob).headline, 'Nobody took it in time');
  assert.equal(jobStatusVM({state: 'expired', current_attempt: started}, ctxJob).text, 'It expired before a result came back.', 'a claimed job is not "no agent started"');
  const unknown = jobStatusVM({state: 'wat?!'}, ctxJob);
  assert.deepEqual([unknown.pill.word, unknown.key], ['Status unavailable', 'unknown']);
  assert.ok(!JSON.stringify(unknown).includes('wat'));
  assert.deepEqual([jobStatusVM({state: 'queued'}, ctxJob).kind, jobStatusVM({state: 'queued'}, ctxJob).stopLabel, jobStatusVM({state: 'result-accepted'}, ctxJob).pill.word], ['waiting', 'Cancel job', 'Ready to review']);
});

// U17: "How it ran" from the receipt the API would send (snake_case, the signed receipt's own fields).
const receiptJob = (extra = {}) => ({receipt: {harness: 'codex', harness_version: '0.9.1', model: 'gpt-x', backend: 'docker-sandboxes', duration_ms: 540000, egress_applied: 'provider-only',
  egress_evidence: {'chatgpt.com:443': 'allowed', 'github.com:443': 'allowed', 'download.docker.com:443': 'allowed', 'pastebin.com:443': 'denied'}, ...extra}});

test('howItRanVM: missing observations keep the known requested agent facts', () => {
  assert.deepEqual(howItRanVM({}).lines, []);
  assert.equal(howItRanVM({}, {role:'ran'}).missing, 'The agent, time used and cleanup were not recorded for this job.');
  assert.equal(howItRanVM({receipt:{}}, {role:'ran'}).missing, 'Cleanup was not recorded for this job.');
  assert.equal(howItRanVM({receipt: 'nope'}, {agent: 'Codex'}).lines[0].text, 'Codex');
});

test('howItRanVM: the two M11 lines come first, then the observed network, and every line has an observer', () => {
  const vm = howItRanVM(receiptJob(), {lender: 'Ana', device: 'MacBook', agent: 'Codex'});
  assert.deepEqual(vm.lines.map(l => l.text), ['Ran on Ana’s MacBook with Codex 0.9.1 (`gpt-x`) in Docker Sandboxes.', 'Used 9 minutes of the lender’s Codex time, measured by Faravan.',
    'Ran 9 min in a new sandbox on Ana’s MacBook.', 'Blocked: `pastebin.com:443`.', 'OpenAI (the agent’s model service): `chatgpt.com:443`.', 'GitHub: `github.com:443`.',
    'Sandbox start-up: `download.docker.com:443`. Docker’s sandbox image and services use these when the sandbox starts; the agent may also have used them.']);
  assert.equal(vm.usage, '', 'no job-count claim: the receipt does not say');
  assert.match(vm.note, /^Each line says who observed it\. Sites come from the Docker Sandboxes network log for this sandbox, read on Ana’s computer after the agent stopped\./);
  assert.ok(vm.lines.every(l => !/\bonly\b|nothing else|reached nothing/i.test(l.text.replace('with only the files', ''))));
});

test('howItRanVM: an unreadable log says so, with the rules; a missing duration says the time is not known', () => {
  const vm = howItRanVM(receiptJob({egress_evidence: {'*': 'unknown'}}), {lender: 'Ana', device: 'MacBook'});
  assert.ok(vm.lines.some(l => l.text === 'The network log couldn’t be read for this job, so we don’t know which sites it reached. The rules allowed: OpenAI.'));
  assert.equal(vm.note, '');
  assert.ok(howItRanVM(receiptJob({egress_evidence: undefined, egress_applied: 'internet'}), {}).lines.some(l => /The rules allowed: public websites\./.test(l.text)));
  assert.ok(howItRanVM(receiptJob({duration_ms: undefined}), {}).lines.some(l => l.text === 'The agent time used isn’t known.'));
});

test('howItRanVM: measured zero and short runs never become a one-minute usage claim', () => {
  for (const [duration_ms, duration, short] of [[0,'0 seconds','0 s'], [500,'1 second','1 s'], [59000,'59 seconds','59 s'], [90000,'1 minute 30 seconds','1 min 30 s']]) {
    const vm = howItRanVM(receiptJob({duration_ms}), {agent:'Codex'});
    assert.equal(vm.lines[1].text, `Used ${duration} of the lender’s Codex time, measured by Faravan.`);
    assert.match(vm.lines[2].text, new RegExp('^Ran ' + short + ' in a new sandbox'));
    if(duration_ms<60000)assert.ok(vm.lines.every(line => !/\b1 min(?:ute)?\b/.test(line.text)));
  }
});

test('howItRanVM: the API’s own provider hosts win over the built-in table; an unknown harness shows its host as another site', () => {
  const own = howItRanVM(receiptJob({harness: 'mystery', provider: 'Acme', provider_hosts: ['**.chatgpt.com']}), {}).lines.map(l => l.text);
  assert.ok(own.includes('Acme (the agent’s model service): `chatgpt.com:443`.'));
  const unknown = howItRanVM(receiptJob({harness: 'mystery'}), {}).lines.map(l => l.text);
  assert.ok(unknown.includes('Other sites (we couldn’t tell which belong to the agent’s model service): `chatgpt.com:443`.'));
});

test('howItRanVM: the job view’s safety facts (S5.1) name the provider and its hosts', () => {
  const job = {...receiptJob({harness: 'mystery'}), safety: {provider: 'openai', provider_hosts: ['**.chatgpt.com']}};
  assert.ok(howItRanVM(job, {}).lines.some(l => l.text === 'OpenAI (the agent’s model service): `chatgpt.com:443`.'));
  assert.ok(howItRanVM({...job, safety: {provider: null, provider_hosts: null}}, {}).lines.some(l => /^Other sites/.test(l.text)), 'nulls fall back to the table, which does not know this harness');
});

test('waitingCopyVM: where it was sent, who takes it, and when it expires, with no start or finish time', () => {
  const vm = waitingCopyVM({state:'queued',waitingTiming: {submittedAt: '2026-10-19T19:41:00Z', expiresAt: '2026-10-20T19:41:00Z'}}, {circle: 'Weekend projects', zone: 'UTC', now:Date.parse('2026-10-19T19:46:00Z')});
  assert.deepEqual([vm.headline, vm.text], ['Waiting for a computer', 'Sent to Weekend projects at 7:41 PM. A lender’s computer takes it when it is free and has time left today. Expires Tuesday 7:41 PM if nobody takes it.']);
  assert.equal(vm.timing, 'Waiting 5 min');
  assert.equal(waitingCopyVM({state:'queued'}, {}).text, 'Sent to the circle. A lender’s computer takes it when it is free and has time left today.');
  assert.ok(!/starts|finishes/i.test(vm.text));
});

test('approval denial explains the last decision only while the job is queued', () => {
  const job={job_digest:'denied',state:'queued',lenderName:'Ana',current_attempt:{reason:'{"code":"approval_denied"}'},
    waitingTiming:{submittedAt:'2026-10-19T19:41:00Z',expiresAt:'2026-10-20T19:41:00Z'},
    waiting_reason:'agent_unavailable',waiting_message:'No available computer right now'};
  const named=waitingCopyVM(job,{circle:'Weekend projects',zone:'UTC',lender:'Ana'});
  assert.deepEqual([named.previousDecision,named.headline,named.text],[
    'Ana declined this request. It went back to the circle; another computer can pick it up.',
    'No available computer right now',
    waitingCopyVM({...job,current_attempt:{}},{circle:'Weekend projects',zone:'UTC'}).text
  ]);
  assert.equal(waitingCopyVM({...job,lenderName:'Mo'},{circle:'Weekend projects',zone:'UTC'}).previousDecision,
    'Mo declined this request. It went back to the circle; another computer can pick it up.');
  const devices={circles:[{circle:'c1',members:[{key_id:'holder-1',localName:'Priya'}]}]};
  assert.equal(waitingCopyVM({...job,lenderName:'',circle:{id:'c1'},current_attempt:{reason:'approval_denied',holder:'holder-1'}},{devices}).previousDecision,
    'Priya declined this request. It went back to the circle; another computer can pick it up.');
  assert.equal(waitingCopyVM({...job,lenderName:'',current_attempt:{reason:'approval_denied'}},{}).previousDecision,
    'A lender declined this request. It went back to the circle; another computer can pick it up.');

  const row=rowsOf(jobsListVM([job],{now:T}))[0];
  assert.equal(row.word,'Waiting · no lender');
  assert.match(row.statusTitle,/Ana declined this request/);
  const neutral=rowsOf(jobsListVM([{...job,waiting_reason:undefined,waiting_message:undefined}],{now:T}))[0];
  assert.equal(neutral.word,'Waiting');
  assert.match(neutral.statusTitle,/Ana declined this request/);
  for (const state of ['running','cancelled']) {
    const stale={...job,state,status:state,current_attempt:{reason:'{"code":"approval_denied"}',execution_started_at:'2026-10-19T18:54:00Z'}};
    assert.equal(waitingCopyVM(stale,{}).previousDecision,'',state);
    assert.equal(rowsOf(jobsListVM([stale],{now:T}))[0].statusTitle,undefined,state);
  }
  const generic=waitingCopyVM({state:'queued'},{});
  assert.deepEqual([generic.headline,generic.previousDecision],['Waiting for a computer','']);
  assert.equal(waitingCopyVM({...job,current_attempt:{reason:{code:'approval_denied'}}},{}).previousDecision,
    'Ana declined this request. It went back to the circle; another computer can pick it up.');
  assert.equal(waitingCopyVM({...job,current_attempt:{reason:'not-json'}},{}).previousDecision,'');
});

test('Not now stays pending and Decline removes the request from this computer', () => {
  const vm=requestTimingVM({requesterName:'Sam'},{circle:'Weekend projects'});
  assert.match(vm.asked,/Not now keeps this request pending until its deadline/);
  assert.match(vm.asked,/Decline removes it from this computer; other lenders can still run it/);
});

// UAT: "Agents checked." with failing rows, two "Claude Code" rows, six adapters read as six problems, a doctor command.
import {agentsCheckedVM, agentSectionsVM, plainRemedy} from './view-models.mjs';
test('agentsCheckedVM says what was found, not just that it ran', () => {
  const ready = {id:'claude-code-subscription', installed:true, signedIn:true}, codex = {id:'codex', installed:true, signedIn:false}, gone = id => ({id, installed:false});
  assert.equal(agentsCheckedVM([ready, codex, gone('gemini'), gone('opencode'), gone('gh-cli'), gone('claude-code-api-key')]), 'Checked. Claude Code is ready. Codex needs you.');
  assert.equal(agentsCheckedVM([ready, {...codex, signedIn:true}]), 'Checked. Claude Code is ready. Codex is ready.');
  assert.equal(agentsCheckedVM([{...codex, signedIn:null}]), 'Checked. Codex couldn’t be checked.');
  assert.equal(agentsCheckedVM([]), 'Checked. No agents were found on this computer.');
  assert.doesNotMatch(agentsCheckedVM([codex]), /^Agents checked\.$/, 'never the bare success when a row needs you');
});

test('the two Claude Code adapters are told apart by their sign-in method', () => {
  assert.equal(agentRowVM({id:'claude-code-subscription'}).name, 'Claude Code');
  assert.equal(agentRowVM({id:'claude-code-api-key'}).name, 'Claude Code (API key)');
});

test('agentSectionsVM: only the two MVP agents show, in their first-run order', () => {
  const list = [{id:'claude-code-subscription', installed:true, signedIn:true}, {id:'codex', installed:true, signedIn:false}, {id:'gh-cli', installed:true, signedIn:null},
    {id:'opencode', installed:false}, {id:'gemini', installed:false, useForLending:false}, {id:'claude-code-api-key', installed:false, useForLending:true}];
  const {shown, other} = agentSectionsVM(list);
  assert.deepEqual(shown.map(a => a.id), ['claude-code-subscription', 'codex']);
  assert.deepEqual(other, []);
});

test('plainRemedy drops any sentence that is a command', () => {
  assert.equal(plainRemedy('Faravan could not check this agent in a test sandbox. Run faravan doctor'), 'Faravan could not check this agent in a test sandbox.');
  assert.equal(plainRemedy('Faravan could not check this agent in a test sandbox. Run faravan doctor'), 'Faravan could not check this agent in a test sandbox.', 'the compatibility command is still recognized');
  assert.equal(plainRemedy('Sign in again. Run `codex login`.'), 'Sign in again.');
  assert.equal(plainRemedy(undefined), '');
});

test('the Home badge does not count the saved lending blocker (the lending card says it)', () => {
  assert.equal(needsYouCount({approvals: [], home: {needs_you: [{kind:'safety_check_failed'}, {kind:'docker_signed_out'}]}}), 0);
  assert.equal(needsYouCount({approvals: [], home: {needs_you: [{kind:'safety_check_failed'}, {label:'Sign in to Claude Code again.'}]}}), 1);
});

// U22: Add as a branch (EXPERIENCE M10).
import {applyPreviewVM, applyRefusalVM, appliedLineVM, jobStateKey as keyOf, JOB_STATES as STATES} from './view-models.mjs';

test('apply lock refusal explains how to recover', () => {
  const view = applyRefusalVM({state:'job.apply-locked', code:'apply_locked'}, {surface:'desktop', capabilities:{localApp:true}});
  assert.match(view.text, /Git.*lock/i);
  assert.match(view.text, /wait|finish/i);
  assert.ok(view.actions.includes('retry'));
  assert.ok(view.actions.includes('recover'));
});
const summary = {job_digest:'sha256:' + '3f9a1c'.padEnd(64, '0'), branch:'faravan/3f9a1c2b7d10', base:'8d01e4' + 'a'.repeat(34), repo:'/home/ana/code/booking-site', head:'b'.repeat(40), current_branch:'feature/checkout', files:3, insertions:71, deletions:4,
  files_changed:[{path:'src/booking/form.tsx', insertions:18, deletions:4}, {path:'src/booking/validate.ts', insertions:31, deletions:0}, {path:'tests/validate.test.ts', insertions:22, deletions:0}]};

test('applyPreviewVM: exactly what would be written, before anything is', () => {
  const vm = applyPreviewVM(summary, {lender:'Ana', digest:summary.job_digest});
  assert.equal(vm.adds.map(p => p.text).join(''), 'Adds the branch faravan/3f9a1c2b7d10 to booking-site.');
  assert.deepEqual(vm.adds.filter(p => p.strong).map(p => p.text), ['faravan/3f9a1c2b7d10', 'booking-site']);
  assert.equal(vm.starts, 'It starts from the version you sent. Your current branch (feature/checkout) and your local changes are not touched.');
  assert.equal(vm.count, '3 files change:');
  assert.deepEqual(vm.files.map(f => [f.path, f.plus, f.minus]), [['src/booking/form.tsx', '+18', '−4'], ['src/booking/validate.ts', '+31', ''], ['tests/validate.test.ts', '+22', '']]);
  assert.equal(vm.commit, 'The result from Ana will be saved on the new branch.');
  assert.equal(applyPreviewVM({...summary, current_branch:null, files:1, files_changed:[]}).starts, 'It starts from the version you sent. Your current files and your local changes are not touched.');
  assert.equal(applyPreviewVM({files:1, files_changed:[{path:'a'}]}).count, '1 file changes:');
});

test('applyRefusalVM: each job.apply-* state has its own words and next step, no raw text, nothing written', () => {
  const ctx = {surface:'desktop',capabilities:{localApp:true},repo:'/home/ana/code/booking-site', base:summary.base, branch:'faravan/3f9a1c2b7d10'};
  const row = (state, code) => { const r = applyRefusalVM({state, code}, ctx); return [r.state, r.text, r.actions, r.reference]; };
  assert.deepEqual(row('job.apply-repo-missing', 'repo_missing'), ['job.apply-repo-missing', 'That folder is no longer a Git project. Choose the folder where the project is now.', ['choose', 'details'], '']);
  assert.deepEqual(row('job.apply-base-missing', 'base_missing').slice(1, 3), ['This project does not have the version the job started from. Get that version or choose the original project folder. Nothing was added.', ['retry', 'choose', 'details']]);
  assert.deepEqual(row('job.apply-branch-exists', 'branch_exists').slice(1, 3), ['That branch name is already here. Review the existing branch or choose another name.', ['rename', 'details']]);
  assert.deepEqual(row('job.apply-conflict', 'patch_conflict').slice(1, 3), ['The changes conflict with your project version. Download and review the result. Nothing was added.', ['patch', 'details']]);
  assert.deepEqual(row('job.apply-unsafe', 'unsafe_patch').slice(1, 3), ['These changes write outside the project or create unsafe links. Nothing was added. Download the result to inspect it safely.', ['details']]);
  assert.deepEqual(row('job.no-changes', 'no_changes').slice(1, 3), ['The agent made no changes. Review the result before preparing a follow-up.', ['followup', 'details']]);
  assert.equal(row('whatever', 'commit_failed')[0], 'job.apply-failed');
  for (const state of ['job.apply-repo-missing', 'job.apply-base-missing', 'job.apply-branch-exists', 'job.apply-conflict', 'job.apply-unsafe', 'job.no-changes', 'job.apply-failed'])
    assert.doesNotMatch(applyRefusalVM({state}, ctx).text, /\bgit fetch\b|undefined|null|faravan apply/i, state);
});

test('"Added as a branch" is a fact the app recorded, and it replaces "Added to your code"', () => {
  assert.equal(keyOf({state:'result-accepted', applied:{branch:'faravan/x', repo:'/r'}}), 'added_branch');
  assert.equal(keyOf({state:'result-accepted', applied:null}), 'ready');
  assert.equal(STATES.added_branch.word, 'Added as a branch');
  assert.ok(!JSON.stringify(STATES).includes('Added to your code'));
  assert.deepEqual(appliedLineVM({branch:'faravan/3f9a1c2b7d10', repo:'/home/ana/code/booking-site/'}), {heading:'Added as branch faravan/3f9a1c2b7d10', repo:'booking-site', switch:'git switch faravan/3f9a1c2b7d10'});
});

test('palette hides local-only circle destinations', () => {
  const result=paletteVM('My devices',{circles:[{id:'local',name:'My devices'}]});
  assert.equal(result.items.length,0);
});






test('setupVM: one ready agent is enough while another needs sign-in', () => {
 const vm = setup({lendingReadiness:setupLendingReady,agents:[{id:'codex',installed:true,signedIn:true,useForLending:true},{id:'claude-code-subscription',installed:true,signedIn:false,useForLending:true}]});
 assert.equal(vm.ready, true);
 assert.equal(vm.steps.find(s=>s.id==='agent:claude-code-subscription').state, 'need');
});



test('waiting reasons change only waiting copy and list labels, retaining timing and controls', () => {
  const message = 'No computer in Faravan test lends Claude Code right now';
  const job = {job_digest:'waiting-reason', state:'queued', status:'Waiting',
    waitingTiming:{submittedAt:'2026-10-19T19:41:00Z', expiresAt:'2026-10-20T19:41:00Z'}};
  const options = {circle:'Faravan test', zone:'UTC'};
  const baseline = waitingCopyVM(job, options);
  const waiting = {...job, waiting_reason:'agent_unavailable', waiting_message:message, message:'Unrelated submit refusal'};
  assert.equal(waitingCopyVM(waiting, options).headline, message);
  assert.equal(waitingCopyVM(waiting, options).text, baseline.text);
  assert.deepEqual(jobStatusVM(waiting, {now:T}), jobStatusVM(job, {now:T}), 'stepper and cancel unchanged');
  const row = value => rowsOf(jobsListVM([value], {now:T}))[0];
  assert.equal(row(waiting).word, 'Waiting · no lender');
  assert.equal(row(waiting).statusTitle, message);
  assert.deepEqual(waitingCopyVM({...job, waiting_message:message}, options), baseline);
  assert.deepEqual(row({...job, waiting_message:message}), row(job));
  for (const waiting_message of ['', '  ', '\t\n']) {
    const blank = {...waiting, waiting_message};
    assert.deepEqual(waitingCopyVM(blank, options), baseline);
    assert.equal(row(blank).word, 'Waiting · no lender');
    assert.equal(row(blank).statusTitle, 'Waiting · no lender');
  }
  for (const state of ['running', 'finished', 'failed', 'expired', 'cancelled']) {
    const stale = {...waiting, state, status:state};
    const control = {...job, state, status:state};
    assert.deepEqual(waitingCopyVM(stale, options), waitingCopyVM(control, options), state);
    assert.deepEqual(row(stale), row(control), state);
    assert.deepEqual(jobStatusVM(stale, {now:T}), jobStatusVM(control, {now:T}), state);
  }
  assert.equal(waitingCopyVM({status:'Waiting', waiting_reason:'agent_unavailable', waiting_message:message}).headline, message);
});


test('the Agent column hides unknown agents while keeping the lender name',()=>{
 const job={job_digest:'unknown-execution',role:'sent',state:'result-accepted',local:{agent:'codex'},lenderName:'Mo'};
 const row=rowsOf(jobsListVM([job]))[0];
 assert.equal(row.agent,'Codex (requested)');assert.equal(row.who,'Mo');
 const ran=rowsOf(jobsListVM([{...job,role:'ran'}]))[0];
 assert.equal(ran.agent,'Codex (requested)');
});

test('offer waiting copy identifies an older deciding lender, ready devices, deadline and a failed preparation',()=>{
 const job={state:'queued',circle:{id:'friends'},offerWaiting:{readyCount:2,deciding:null},waitingTiming:{expiresAt:'2026-10-20T19:41:00Z'}};
 const devices={circles:[{circle:'friends',members:[{key_id:'sam',localName:'Sam'}]}]};
 const open=waitingCopyVM(job,{devices,zone:'UTC'});
 assert.equal(open.headline,'Waiting for someone to run it');assert.match(open.text,/2 lending devices are ready.*Open until Tuesday 7:41 PM/);
 assert.equal(waitingCopyVM({...job,offerWaiting:{readyCount:1,deciding:'sam'}},{devices,zone:'UTC'}).headline,'Sam is deciding (older app)');
 assert.equal(waitingCopyVM({...job,current_attempt:{holder:'sam',state:'failed',execution_started_at:null,reason:'sandbox_failed'}},{devices}).previousDecision,'Sam couldn’t start it; it’s open again.');
});

test('modern offer waiting keeps the shared reason alongside its deadline', () => {
 const explanation='Waiting for someone to run it · 2 are answering another job · 1 is outside lending hours.';
 const vm=waitingCopyVM({state:'queued',offerWaiting:{readyCount:0},statusContract:{lifecycle:'waiting',explanation},waitingTiming:{expiresAt:'2026-10-20T19:41:00Z'}},{zone:'UTC'});
 assert.match(vm.text,/2 are answering another job · 1 is outside lending hours/);
 assert.doesNotMatch(vm.text,/Waiting for someone to run it/);
 assert.match(vm.text,/Open until Tuesday 7:41 PM/);
 assert.doesNotMatch(vm.text,/0 lending devices/);
});


test('O-F: when nobody can take the job the heading says so and the line names who is out', () => {
 const explanation='Nobody can take it right now · Maya Okafor isn’t lending (done for today).';
 const vm=waitingCopyVM({state:'queued',offerWaiting:{readyCount:0},statusContract:{lifecycle:'waiting',explanation},waitingTiming:{expiresAt:'2026-10-20T19:41:00Z'}},{zone:'UTC'});
 assert.equal(vm.headline,'Nobody can take it right now');
 assert.match(vm.text,/^Maya Okafor isn’t lending \(done for today\)\. Open until Tuesday 7:41 PM\.$/);
 // A computer that might still take it keeps the hopeful heading.
 const open=waitingCopyVM({state:'queued',offerWaiting:{readyCount:1},statusContract:{lifecycle:'waiting',explanation:'Waiting for someone to run it · 1 computer is ready. Another computer may still take this job.'}},{zone:'UTC'});
 assert.equal(open.headline,'Waiting for someone to run it');
});

test('O-I: a plain-folder result promises a ZIP and a Changes list only when it has changes', () => {
 assert.equal(plainFolderResultCaption(true), 'No files changed. Your sent folder stays unchanged.');
 assert.equal(plainFolderResultCaption(false), 'The ZIP contains new and changed files. Deleted files are listed in Changes. Your sent folder stays unchanged.');
});

test('app approval facts drive claimed borrower and lender views before execution', () => {
  for (const [approval, key] of [['approved','approved'], ['pending','waiting_approval'], [null,'waiting'], [undefined,'waiting']]) {
    const job = {state:'claimed',approval,current_attempt:{holder:'lender',execution_started_at:null}};
    assert.equal(jobStateKey(job), key);
    for (const role of ['sent','ran']) {
      assert.equal(jobStateView(job,{role}).key, key);
      assert.equal(jobStatusVM(job,{role}).key, key);
    }
    const started = {...job,approval:approval === 'pending' ? 'pending' : approval,
      current_attempt:{...job.current_attempt,execution_started_at:'2026-10-19T18:54:00Z'}};
    assert.equal(jobStateKey(started), approval === 'pending' ? 'unknown' : 'working');
  }
});

import {jobRoleVM, jobDetailVM, needsYouItems} from './view-models.mjs';

// Reuse the same frozen API objects across renders; do not inject own=true or a
// borrower role. The jobs response is independent of the slower devices read.
const arrivalJob = freeze({job_digest:'arrival-job', circle:{id:'friends'},
  borrowerCircle:'friends', title:'Fix the parser', state:'running',
  historyIdentity:{author:'old-self',personName:'Me'},
  current_attempt:{holder:'old-self',execution_started_at:'2026-10-19T15:00:00Z'}});
const arrivalCard = freeze({id:'arrival-approval',jobDigest:'arrival-job',
  requester:'old-self',job:{circle:'friends'}});
function assertArrivalOwn(jobs, devices, approvals = [arrivalCard]) {
  const current = jobs[0], role = jobRoleVM(current, devices?.fingerprint);
  assert.equal(role, 'sent', 'borrower evidence must work before devices arrives');
  const detail = jobDetailVM(current, {role});
  assert.equal(detail.receipt, false, 'never a receipt for running someone else’s job');
  const list = jobsListVM(jobs.map(job => ({...job,role:jobRoleVM(job,devices?.fingerprint)})),
    {devices,now,computerZone:'UTC'});
  const row = list.groups.flatMap(group => group.rows)[0];
  assert.equal(row.role, 'sent');
  assert.equal(row.title, 'Fix the parser');
  assert.equal(row.glyph, 'arrow-up-right');
  assert.equal(row.avatar, null);
  assert.doesNotMatch(row.who + ' ' + row.whoShort, /ran for|ran here|You ran/);
  const home = {needs_you:[{kind:'request',approvalId:arrivalCard.id},
    {kind:'approval',id:'digest-only',job_digest:arrivalJob.job_digest}]};
  const items = needsYouItems({jobs,approvals,home});
  assert.deepEqual(items.filter(item => ['request','approval'].includes(item.kind)), [],
    'neither live cards nor status attention may request approval for this job');
}
test('identity arrival: unknown first, then loaded, preserves positive borrower attribution', () => {
  for (const devices of [undefined, {fingerprint:'old-self'}])
    assertArrivalOwn([arrivalJob], devices);
});
test('identity arrival: jobs and approvals render before devices, then recompute without mutation', () => {
  assert.equal(jobsListVM([], {now}).count, 0);
  const jobs = freeze([arrivalJob]);
  const before = JSON.stringify(jobs);
  assertArrivalOwn(jobs, {});
  assertArrivalOwn(jobs, {fingerprint:'old-self'});
  assert.equal(JSON.stringify(jobs), before);
});
test('identity arrival: re-pairing never turns locally submitted jobs into lender receipts or requests', () => {
  for (const evidence of [{borrowerCircle:'friends'}, {local:{title:'Fix the parser'}}]) {
    const ownJob = freeze({...arrivalJob,borrowerCircle:undefined,...evidence});
    for (const fingerprint of ['old-self', undefined, 'new-self'])
      assertArrivalOwn([ownJob], {fingerprint});
  }
  const otherJob = {...arrivalJob,borrowerCircle:undefined};
  assert.equal(jobRoleVM(otherJob,'old-self'),'ran');
  assert.equal(jobRoleVM(otherJob,'new-self'),'viewer', 'do not cache the old lender identity');
});
test('identity arrival: absent or empty fingerprint still uses borrower evidence, not an empty-key match', () => {
  for (const devices of [{}, {fingerprint:undefined}, {fingerprint:null}, {fingerprint:''}])
    assertArrivalOwn([arrivalJob],devices);
  assert.equal(jobRoleVM({current_attempt:{holder:''}},''),'viewer');
});
test('own approval filtering retains other jobs and does not match a different circle', () => {
  const other = {...arrivalCard,id:'other',jobDigest:'other-job',requester:'friend'};
  const otherCircle = {...arrivalCard,id:'another-circle',job:{circle:'elsewhere'}};
  const items = needsYouItems({jobs:[arrivalJob],approvals:[arrivalCard,other,otherCircle],
    home:{needs_you:[{kind:'request',approvalId:arrivalCard.id},
      {kind:'request',approvalId:other.id}]}});
  assert.deepEqual(items.map(item => item.approvalId),['other','another-circle']);
});

// Judge r8 O11: after "Check again" with Docker missing, the toast said "Claude Code is ready" while the page row said
// "Waiting for Docker Sandboxes". The toast now reads each agent through the page's own row and blocker model.
test('O11: Check again never calls an agent ready while the page shows it waiting for Docker', async () => {
  const {agentsCheckedVM} = await import('./view-models.mjs');
  const claude = {id:'claude-code-subscription', useForLending:true, installed:true, signedIn:true, checkedAt:Date.now()};
  const codex = {id:'codex', useForLending:true, installed:true, signedIn:false, checkedAt:Date.now()};
  const bl = blockersFor({status:{intent:{state:'ready'},lending:{enabled:true}}, readiness:dockerOut, agents:[claude, codex]});
  const text = agentsCheckedVM([claude, codex], bl.byAgent);
  assert.doesNotMatch(text, /Claude Code is ready/);
  assert.match(text, /^Checked\. Claude Code is waiting for the Docker sign-in\./);
  assert.equal(agentsCheckedVM([claude]), 'Checked. Claude Code is ready.', 'with nothing computer-wide in the way it is ready');
});

// Judge r8 O15 / I09: blocked lending never reads as on and ready. The projection's one formatter owns the headline.
test('I09: a blocked lending projection does not lead with "Lending is on"', async () => {
  const {lendingVerdictVM} = await import('./view-models.mjs');
  const {withLendingProjection} = await import('./lending-projection.fixture.mjs');
  const status = withLendingProjection({intent:{on:true,state:'blocked',reason:'circle_unreachable'}, lending:{enabled:true}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'circle_unreachable'});
  const vm = lendingVerdictVM(status, {first:null,items:[],byAgent:{},needsYou:[]});
  assert.equal(vm.headline, 'Jobs can’t start');
  assert.doesNotMatch(vm.headline + ' ' + vm.reason, /Lending is on|Ready for requests/);
  assert.equal(vm.on, true, 'the switch still shows the choice');
});

test('own execution copy uses explicit identity for running, finishing and stopping only',()=>{
 for(const state of ['running','finishing','stopping'])for(const own of [true,false,undefined]) {
   const h=withLendingProjection({execution:{state,job:'job-1',person:'Maya Okafor',own}},
     {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:state,executionJob:'job-1'});
   const verb={running:'Running',finishing:'Finishing',stopping:'Stopping'}[state];
   assert.equal(machineVM(h,{}).line,verb+' '+(own===true?'your job':'Maya Okafor’s job'));
   assert.equal(lendingVM(h).headline,verb+' '+(own===true?'your job':'Maya Okafor’s job'));
 }
 const unknown=withLendingProjection({execution:{state:'running',job:'job-1'}},
   {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'running',executionJob:'job-1'});
 assert.equal(machineVM(unknown,{}).line,'Running a job');
 const request=withLendingProjection({execution:{state:'idle',own:true}},
   {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'idle',executionJob:null});
 assert.equal(machineVM(request,{}).line,'Starting a job');
});

test('shell follows a started lender job while the admission projection still says busy',()=>{
 const home=withLendingProjection({execution:{state:'idle'},lending:{enabled:true}},
   {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'idle'});
 const job={role:'ran',state:'claimed',current_attempt:{execution_started_at:'2026-10-19T18:54:00Z'},
   historyIdentity:{localName:'Sam'}};
 assert.deepEqual(machineVM(home,{}, {jobs:[job]}),{
   name:'This computer',line:'Running Sam’s job',kind:'run',word:'Running',state:'running',
 });
 const saved={...job,jobProjection:qualifyJobProjection(adaptLegacyJob(job),{state:'last_known'})};
 assert.equal(machineVM(home,{}, {jobs:[saved]}).line,'Starting a job',
   'a saved running record does not override the current admission and execution read');
});

test('self-run sent jobs override stale busy projection only with fresh execution evidence', () => {
  const home = withLendingProjection({execution:{state:'idle'},lending:{enabled:true}},
    {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'idle'});
  const job = {role:'sent',ran:true,state:'claimed',current_attempt:{execution_started_at:'2026-10-19T18:54:00Z'}};
  assert.equal(machineVM(home,{}, {jobs:[job]}).word, 'Running');
  const saved = {...job,jobProjection:qualifyJobProjection(adaptLegacyJob(job),{state:'last_known'})};
  assert.equal(machineVM(home,{}, {jobs:[saved]}).word, 'Starting');
  assert.equal(machineVM(home,{}, {jobs:[{...job,ran:false}]}).word, 'Starting');
});
test('failed no-project and unknown-source jobs do not invent code changes or a cause', async () => {
  const {jobStatusVM} = await import('./view-models.mjs');
  const failed = {state:'failed',current_attempt:{state:'failed',reason:{code:'execution_failed',phase:'run'}}};
  for (const local of [{sourceKind:'none'}, {}]) {
    const view = jobStatusVM({...failed,local}, {role:'sent'});
    assert.doesNotMatch(view.text, /Nothing was added to your code/);
    assert.match(view.text, /details|transcript/i);
  }
  assert.match(jobStatusVM({...failed,local:{sourceKind:'folder',sourcePath:'/example/project'}},{role:'sent'}).text,/Nothing was added to your code/);
});

function fallbackIdentityFixture(own) {
  const name='Maya Okafor',self='sha256:'+'a'.repeat(64),other='sha256:'+'b'.repeat(64);
  const devices={name:'Laptop',ownerName:name,fingerprint:self};
  const home=withLendingProjection({execution:{state:'idle'},lending:{enabled:true}},
    {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'idle'});
  const row={job_digest:'sha256:'+'c'.repeat(64),circle:{id:'c1'},role:own?'sent':'ran',ran:true,state:'claimed',
    current_attempt:{holder:self,attempt_id:'a1',generation:1,state:'active',execution_started_at:'2026-10-19T18:54:00Z'},
    historyIdentity:{author:own?self:other,personName:name},
    ...(own?{local:{title:'Own job',prompt:'Do the work'}}:{})};
  return {name,devices,home,row};
}
for(const own of [true,false])test('newer jobs sidebar fallback preserves signed ownership with identical labels: '+own,()=>{
  const {name,devices,home,row}=fallbackIdentityFixture(own);
  assert.equal(machineVM(home,devices,{jobs:[row]}).line,own?'Running your job':'Running '+name+'’s job');
});
test('saved own and foreign jobs do not replace current sidebar admission',()=>{
  for(const own of [true,false]){
    const {devices,home,row}=fallbackIdentityFixture(own);
    const saved={...row,jobProjection:qualifyJobProjection(adaptLegacyJob(row),{state:'last_known'})};
    assert.equal(machineVM(home,devices,{jobs:[saved]}).line,'Starting a job');
  }
});
test('sent jobs not run here do not override the sidebar',()=>{
  const {devices,home,row}=fallbackIdentityFixture(true);
  assert.equal(machineVM(home,devices,{jobs:[{...row,ran:false}]}).line,'Starting a job');
});
test('coherent Home execution retains own and foreign identity independently of fallback',()=>{
  for(const own of [true,false]){
    const {name,devices,row}=fallbackIdentityFixture(own);
    const home=withLendingProjection({execution:{state:'running',job:'a1',person:name,own},lending:{enabled:true}},
      {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',execution:'running',executionJob:'a1'});
    assert.equal(machineVM(home,devices,{jobs:[row]}).line,own?'Running your job':'Running '+name+'’s job');
  }
});

test('update availability uses authoritative service states without claiming installation', async () => {
  const {updateVM} = await import('./view-models.mjs');
  const {createUpdateService} = await import('../../../lib/v1/update-service.mjs');
  const updater = {
    check:async()=>({current:'1.0.0',manifest:{version:'1.1.0',release_notes_url:'https://untrusted.invalid/notes'}}),
    tick:async()=>'staged',
    status:async()=>({currentVersion:'1.0.0',candidate:'1.1.0'}),
  };
  const service=createUpdateService({updater,currentVersion:'1.0.0'});
  assert.equal(updateVM({},service.status()),null);
  const available=updateVM({},await service.check());
  assert.equal(available.actionKind,'updates');
  assert.equal(available.action,'View updates');
  assert.equal(available.version,'1.1.0');
  assert.equal(available.href,undefined);
  assert.notEqual(available.action,'Reload');
  await service.tick();
  const staged=updateVM({},service.status());
  assert.equal(staged.actionKind,'updates');
  assert.match(staged.text,/waiting to be installed/);
  assert.equal(updateVM({},service.status(),['1.1.0']),null);
  assert.equal(updateVM({},{...service.status(),candidate:'1.2.0'},['1.1.0']).version,'1.2.0');
  for(const state of ['current','idle','managed','checking','failed','rolled_back','applied','unknown',undefined])
    assert.equal(updateVM({},{state,candidate:'1.1.0',currentVersion:'1.0.0'}),null,String(state));
  for(const candidate of [null,undefined,'',{},'1.0.0'])
    assert.equal(updateVM({},{state:'available',candidate,currentVersion:'1.0.0'}),null);
  assert.deepEqual(updateVM({},{state:'available',candidate:'1.1.0',checkedAt:'later'}),available);
});

test('package availability never replaces the existing ready or restarting UI signal', async () => {
  const {updateVM} = await import('./view-models.mjs');
  const available={state:'available',candidate:'1.1.0'};
  const ready=updateVM({update:{ready:true,version:'1.0.1'}},available,['1.1.0']);
  assert.deepEqual(ready,{icon:'refresh',text:'A new version of Faravan is ready.',action:'Reload',version:'1.0.1'});
  const restarting=updateVM({update:{state:'restarting',version:'1.0.1'}},available);
  assert.equal(restarting.action,null);
  assert.match(restarting.text,/reconnects by itself/);
});

test('update toast routes package availability through its callback and preserves explicit reload', async t => {
  const {updateVM} = await import('./view-models.mjs');
  const {UpdateToast} = await import('./shell-states.jsx');
  const button = node => {
    if(!node||typeof node!=='object')return null;
    if(node.type==='button')return node;
    for(const child of [node.props?.children].flat(Infinity)){const found=button(child);if(found)return found;}
    return null;
  };
  let opened=0,reloaded=0;
  const prior=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{reload:()=>{reloaded++;}}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'location',prior);else delete globalThis.location;});
  const available=updateVM({},{state:'available',candidate:'1.1.0',notesUrl:'https://untrusted.invalid/'});
  button(UpdateToast({vm:available,onOpenUpdates:()=>{opened++;}})).props.onClick();
  assert.equal(opened,1);assert.equal(reloaded,0);
  button(UpdateToast({vm:updateVM({update:{ready:true}}),onOpenUpdates:()=>{opened++;}})).props.onClick();
  assert.equal(opened,1);assert.equal(reloaded,1);
  assert.equal(button(UpdateToast({vm:updateVM({update:{state:'restarting'}})})),null);
});
test('jobStatusVM: a result after a lender stop says the job was stopped early, for both people', () => {
  const attempt = {attempt_id: 'a1', generation: 1, holder: 'k', state: 'completed', execution_started_at: '2026-10-19T18:54:00Z'};
  const job = {job_digest: 'sha256:d1', state: 'result-accepted', status: 'Finished', result_digest: 'sha256:r1', current_attempt: attempt};
  const stopRequest = {attempt_id: 'a1', generation: 1, job_digest: 'sha256:d1', requested_at: '2026-10-19T18:56:00Z'};
  assert.equal(jobStatusVM({...job, stopRequest}, ctxJob).text, 'Ana stopped this job early. This is the work done until then.');
  assert.equal(jobStatusVM({...job, stopRequest}, {...ctxJob, role: 'ran'}).text, 'You stopped this job early. This is the work done until then.');
  // This computer ran an earlier attempt, but another lender ran and stopped the current one.
  assert.equal(jobStatusVM({...job, stopRequest}, {...ctxJob, role: 'ran', ownRun: false}).text, 'Ana stopped this job early. This is the work done until then.');
  assert.equal(jobStatusVM({...job, stopRequest}, ctxJob).stoppedEarly, true, 'the job page shows the stop note beside the result');
  assert.equal(jobStatusVM(job, ctxJob).stoppedEarly, undefined);
  assert.equal(jobsListVM([{...job, role: 'sent', lenderName: 'Ana', stopRequest}]).groups[0].rows[0].stopNote,
    'Ana stopped this job early. This is the work done until then.', 'a list row carries the note to the Home result card');
  assert.equal(jobsListVM([{...job, role: 'sent', lenderName: 'Ana'}]).groups[0].rows[0].stopNote, '');
  assert.equal(jobStatusVM(job, ctxJob).text, '', 'an ordinary result says nothing about a stop');
  assert.equal(jobStatusVM({...job, stopRequest: {...stopRequest, attempt_id: 'other'}}, ctxJob).text, '', 'a stop for another attempt is ignored');
});

test('F6 unconfirmed cessation never turns a configured deadline into a guarantee', () => {
  for(const hardStopAt of ['2026-10-19T18:00:00Z','2026-10-19T20:00:00Z']) {
    // Classification comes from the job projection, so the fixture carries one with a failed stop verification.
    const jobProjection={schemaVersion:2,kind:'job',phase:'stopping',reasonCode:'stop_unconfirmed',
      result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
      evidence:{rawState:'stop-requested',attemptPresent:true,approval:'approved',executionStartedAt:started.execution_started_at,computeStopped:false,stopVerification:'failed'},
      version:{},times:{observedAt:'2026-10-19T19:00:00Z',validUntil:null,nextTransitionAt:null},actionHints:[]};
    const vm=jobStatusVM({state:'cancelled',current_attempt:{...started,compute_stopped:false},runTiming:{hardStopAt},jobProjection},ctxJob);
    assert.equal(vm.key,'stop_unconfirmed');
    assert.match(vm.text,/Its configured stop time is/);
    assert.match(vm.text,/Faravan has not confirmed that it stopped/);
    assert.doesNotMatch(vm.text,/can’t run past|has stopped|stopped at/);
    assert.match(vm.text+' '+vm.note,/Copy the details if you need help checking the running computer/);
  }
});


// Installed multi-provider lender regressions. Synthetic snapshots, not live validation.
const executingLender = (execution = 'running', extra = {}) => withLendingProjection({needs_you:[],intent:{on:true,state:'ready'},execution:{state:execution,job:'codex-attempt',person:'Alex Example'},lending:{enabled:true,current:'codex-attempt',agent:'codex',
    accountStates:[{current:'claude-other',agent:'claude-code-subscription'},
      {current:'codex-attempt',agent:'codex'}]},allowance:{provider:'claude',remaining:100,observedAt:now-1000,resetsAt:now+86400000},...extra}, {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'busy',
  execution,executionJob:'codex-attempt'});

test('running Codex card shows the Codex meter and never borrows Claude week allowance', () => {
  const home=executingLender();
  const vm=lendPageVM(home,{agents:[claude,codex],now});
  assert.equal(vm.headline,'Running Alex Example’s job');
  assert.deepEqual(vm.meters,[],'no Codex reading means no provider meter');
  const windows=[{window_id:'codex:10080',window_minutes:10080,state:'open',
    used_pct:37,observed_at:now-1000,resets_at:now+86400000}];
  const known=lendPageVM({...home,lendingPolicy:{accounts:[{provider:'codex',decision:{windows}}]}},{now});
  assert.equal(known.meters[0].label,'Codex this week');
  assert.equal(known.meters[0].value,'63%');
  const unknown=lendPageVM({...home,lending:{...home.lending,current:'other',accountStates:[]}},{now});
  assert.deepEqual(unknown.meters,[],'unmatched attempt cannot inherit the aggregate agent');
  assert.doesNotMatch(unknown.headline,/Codex|Claude/);
});

test('running account quota is not a synthetic next-job hold; other accounts stay held', () => {
  const held={admitted:false,reason:'refresh_failed',status:{line:'Holding — recent usage could not be measured.'}};
  const snapshot={accounts:['claude','codex'].map(provider=>({provider,decision:{availability:held}}))};
  const rows=lendingQuotaLinesVM(snapshot,true,executingLender());
  assert.match(rows[0].text,/Holding/);
  assert.equal(rows[1].text,'Lending to a friend now. The next request gets a fresh allowance check.');
  assert.doesNotMatch(rows[1].text,/Holding|could not be measured|open to lend|approve each/);
  const idle={...executingLender(),lendingProjection:{...executingLender().lendingProjection,execution:'idle',executionJob:null}};
  assert.match(lendingQuotaLinesVM(snapshot,true,idle)[1].text,/Holding/,'finished execution cannot reuse old admission');
});

test('stopping supersedes a start-failure reason and offers no resume action', () => {
  const home=executingLender('stopping',{intent:{on:true,state:'blocked',reason:'lending_not_started'},
    lendingStartFailed:{circleName:'Weekend',code:'lending_not_started'}});
  home.lendingProjection={...home.lendingProjection,admissionReason:'lending_not_started'};
  const vm=lendPageVM(home,{agents:[claude,codex],now});
  assert.equal(vm.reason,'Stopping this job. Lending will be off after it stops.');
  assert.equal(vm.exec.canStop,false);
  assert.ok(!vm.blockers.needsYou.some(item=>item.action==='Resume now'));
  assert.doesNotMatch(JSON.stringify(vm.blockers),/Lending couldn’t start/);
  const failed=page({state:'blocked',reason:'lending_not_started',lendingStartFailed:{circleName:'Weekend'}});
  assert.equal(failed.lendingProjection.admissionReason,'conditions_unavailable');
  assert.match(failed.reason,/Lending couldn’t start/,'a real failed start keeps its explanation');
});

test('idle stale allowance evidence remains held even without a pending request', () => {
  const decision={admitted:false,reason:'seam_unknown_meter_age',
    status:{line:'Lending is waiting because the allowance reading is too old or has an inconsistent time.'}};
  const snapshot={accounts:[{provider:'codex',decision}]};
  const idle=withLendingProjection({needs_you:[],lending:{enabled:true,current:null},lendingPolicy:snapshot},
    {intent:'on',intentState:'ready',admission:'allowed',execution:'idle',executionJob:null});
  assert.match(lendingQuotaLinesVM(snapshot,false,idle)[0].text,/Lending is waiting/);
  assert.match(lendPageVM(idle,{agents:[codex],now}).reason,/Lending is waiting/);
  for(const needs_you of [[{kind:'approval',approvalId:'pending'}],undefined]) {
    const pending={...idle,needs_you};
    assert.match(lendingQuotaLinesVM(snapshot,false,pending)[0].text,/Lending is waiting/);
  }
});

test('a recent weekly sample cannot turn a stale decision into current eligibility', () => {
  // A recent raw sample is not a fresh admission projection. The stale decision still holds.
  const observedAt = new Date(Date.now() - 60000).toISOString();
  const window = {window_id: 'codex:10080', window_minutes: 10080, state: 'open', used_pct: 11, observed_at: observedAt, resets_at: new Date(Date.now() + 86400000 * 4).toISOString()};
  const decision = {admitted: false, reason: 'seam_unknown_meter_age', windows: [window],
    status: {line: 'Lending is waiting because the allowance reading is too old or has an inconsistent time.'}};
  const snapshot = {accounts: [{provider: 'codex', decision}]};
  const idle = withLendingProjection({needs_you: [], lending: {enabled: true, current: null}, lendingPolicy: snapshot},
    {intent: 'on', intentState: 'ready', admission: 'allowed', execution: 'idle', executionJob: null});
  const allowance = lendingQuotaLinesVM(snapshot, false, idle)[0].text;
  assert.match(allowance, /Lending is waiting/);
  assert.doesNotMatch(allowance, /Allowance will be checked when the next request arrives/);
  assert.match(lendPageVM(idle, {agents: [codex], now}).reason, /Lending is waiting/);
  assert.doesNotMatch(lendPageVM(idle, {agents: [codex], now}).reason, /Allowance will be checked when the next request arrives/);
});

for (const [role, noChanges, expected] of [
  ['sent', false, 'Stopped early · ready to review'],
  ['ran', false, 'Stopped early · sent back'],
  ['sent', true, 'Stopped early · no changes'],
  ['ran', true, 'Stopped early · no changes'],
]) test('stopped-early result words stay consistent: ' + role + ' / empty=' + noChanges, () => {
  const id = 'sha256:stopped-label';
  const record = {job_digest:id, role, state:'result-accepted', result_digest:'sha256:result',
    current_attempt:{attempt_id:'a1',generation:1,holder:'lender',state:'completed',execution_started_at:'2026-10-19T18:54:00Z'},
    stopRequest:{attempt_id:'a1',generation:1,job_digest:id,requested_at:'2026-10-19T18:56:00Z'},
    receipt:{candidate_format:'diff',diffstat:{files:noChanges ? 0 : 1}},
    ...(role === 'sent' ? {local:{title:'Partial repair'}} : {})};
  const identity = jobVM(record, role);
  const status = jobStatusVM(record, {role});
  const row = jobsListVM([record]).groups[0].rows[0];
  assert.equal(identity.key, 'ready', 'display words do not change the accepted-result state');
  assert.equal(identity.word, expected);
  assert.equal(identity.listWord, expected);
  assert.equal(row.word, expected);
  assert.equal(jobStateView(record, {role}).word, expected);
  assert.equal(status.pill.word, expected);
  assert.equal(status.headline, expected);
  assert.equal(jobRowVM(record, {role:role === 'sent' ? 'borrower' : 'lender'}).headline, expected);
  assert.match(row.stopNote, /stopped this job early/);
  const home = homePageVM({jobs:[record],approvals:[],home:{}});
  assert.equal((home.result ?? home.recent[0]).word, expected, 'Home does not overwrite the lender word');
  if (role === 'sent' && !noChanges) {
    const page = jobPageVM({...record,canSetBorrowerOutcome:true}, {summary:'Partial repair'}, {role:'borrower'});
    assert.equal(page.summary, 'Partial repair');
    assert.ok(page.actions.some(action => action.label === 'Download as .zip'), 'a display qualifier does not remove result actions');
  }
  const ordinary = {...record,stopRequest:undefined};
  const viewer = {role:role === 'sent' ? 'borrower' : 'lender'};
  const changes = {format:'diff',files:noChanges ? [] : [{path:'file.txt'}]};
  assert.deepEqual(jobPageVM(record, changes, viewer).actions, jobPageVM(ordinary, changes, viewer).actions, 'stopping early changes labels, not result actions');
  assert.equal(row.needs, !noChanges && role === 'sent', 'empty results do not regain review attention');
  assert.equal(jobVM(ordinary, role).listWord, noChanges ? 'No changes' : role === 'ran' ? 'Sent back' : 'Ready to review');
});

test('hard-stopped jobs stay stopped and never enter Home results', () => {
  const record = {job_digest:'sha256:hard-stop',state:'cancelled',role:'sent',local:{title:'Stopped repair'},
    current_attempt:{compute_stopped:true,execution_started_at:'2026-10-19T18:54:00Z'}};
  const identity = jobVM(record);
  assert.equal(identity.key, 'stopped');
  assert.equal(identity.word, 'Stopped');
  assert.equal(identity.listWord, 'Stopped');
  assert.doesNotMatch(JSON.stringify(jobStatusVM(record)), /Ready to review/);
  const home = homePageVM({jobs:[record],approvals:[],home:{}});
  assert.equal(home.result, null);
  assert.equal(home.recent[0].word, 'Stopped');
});

test('a result added as a branch keeps a known headline, and a stopped one keeps its qualifier', () => {
  const id = 'sha256:added-branch';
  const base = {job_digest:id, role:'sent', state:'result-accepted', result_digest:'sha256:result', applied:{branch:'faravan/x', repo:'/r'},
    current_attempt:{attempt_id:'a1',generation:1,holder:'lender',state:'completed',execution_started_at:'2026-10-19T18:54:00Z'},
    receipt:{candidate_format:'diff',diffstat:{files:1}}, local:{title:'Partial repair'}};
  const plain = jobStatusVM(base, {role:'sent'});
  assert.equal(plain.key, 'added_branch');
  assert.doesNotMatch(plain.headline, /can.t tell what happened/);
  assert.equal(jobVM(base, 'sent').word, 'Added as a branch');
  const stopped = {...base, stopRequest:{attempt_id:'a1',generation:1,job_digest:id,requested_at:'2026-10-19T18:56:00Z'}};
  const status = jobStatusVM(stopped, {role:'sent'}), identity = jobVM(stopped, 'sent');
  assert.equal(status.key, 'added_branch', 'the applied state is unchanged');
  assert.equal(status.pill.word, 'Stopped early · added as a branch');
  assert.equal(identity.listWord, 'Stopped early · added as a branch');
  assert.match(identity.stopNote, /stopped this job early/);
});

test('lender starting is not relabelled as running by either role adapter', () => {
  const starting = {role:'ran',state:'starting',approval:'approved',
    current_attempt:{attempt_id:'a1',generation:1,state:'active',approved_at:'2026-10-19T14:59:00Z'}};
  assert.equal(jobStateKey(starting),'starting','fixture has not started execution');
  assert.equal(jobStateView(starting,{role:'ran'}).word,'Starting');
  assert.equal(jobVM(starting,'ran').word,'Starting');
  assert.equal(jobVM({...starting,role:'received'},'received').word,'Preparing');
});

test('Setup and Lending share selected-account holds without claiming admission readiness', async () => {
  const {lendingVerdictVM} = await import('./view-models.mjs');
  const agents = [{id:'codex',installed:true,signedIn:true,useForLending:true}];
  for (const who of ['owner','automatic']) {
    const reason = who === 'owner' ? 'Sign in to this account again.' : 'Waiting for the allowance to refresh.';
    const held = withLendingProjection({lending:{enabled:true},lendingPolicy:{accounts:[
      {provider:'codex',decision:{availability:{admitted:false,status:{line:reason,recovery:{who}}}}}
    ]}},{intent:'on',intentState:'ready',admission:'allowed',execution:'idle'});
    const setup = setupVM({status:held,agents});
    const lend = lendPageVM(held,{agents});
    const verdict = lendingVerdictVM(held,undefined,'UTC',agents);
    assert.equal(setup.headline,who === 'owner' ? 'Check lending accounts' : 'Lending on · Codex holding');
    assert.equal(setup.headline,lend.headline);
    assert.equal(setup.lead,reason);
    assert.equal(verdict.ready,false,'setup prerequisites do not prove account admission');
    assert.equal(lendPageVM(held,{agents:[{...agents[0],useForLending:false}]}).accountHold,false);
  }
});
import {formatMembership} from './membership-projection-view.mjs';
import {restartLine} from './view-models.mjs';
test('setup pending automatic membership uses the same policy-aware banner as Circles',()=>{
  const pending={...circle,owned:false,joinInfo:{ownerName:'Ana'},membershipProjection:{
    schemaVersion:2,kind:'membership',phase:'pending',evidence:{enrollmentState:'pending',origin:true},invitationPolicy:'automatic',
  }};
  for(const unsupported of [false,true]) {
    const vm=setup({circle:pending,...(unsupported?{status:{desktop:{platform:'windows'}}}:{})});
    const text=unsupported?vm.card.text:vm.steps.find(step=>step.id==='circle').detail;
    assert.equal(text,formatMembership(pending,{surface:'banner'}).message);
    assert.match(text,/Request sent/);assert.doesNotMatch(text,/waiting for approval/);
  }
});
test('setup preserves rejected and expired membership banners on supported and unsupported computers',()=>{
  const messages=[];
  for(const phase of ['rejected','expired']) {
    const pending={...circle,owned:false,membershipProjection:{
      schemaVersion:2,kind:'membership',phase,evidence:{enrollmentState:phase,origin:true},invitationPolicy:'each',
    }};
    const expected=formatMembership(pending,{surface:'banner'}).message;messages.push(expected);
    for(const unsupported of [false,true]) {
      const vm=setup({circle:pending,...(unsupported?{status:{desktop:{platform:'windows'}}}:{})});
      assert.equal(unsupported?vm.card.text:vm.steps.find(step=>step.id==='circle').detail,expected);
    }
  }
  assert.notEqual(messages[0],messages[1]);
});
test('restart copy follows projected off, paused and unknown intent over legacy on',()=>{
  const legacy={intent:{on:true,state:'ready'},lending:{enabled:true}};
  const projected=(intent,intentState,admission='blocked',admissionReason=intent)=>
    withLendingProjection(legacy,{intent,intentState,admission,admissionReason});
  assert.match(restartLine(projected('off','off')),/^Lending is off\./);
  assert.match(restartLine(projected('paused','paused')),/^Lending is paused/);
  assert.equal(restartLine(projected('unknown',null,'unknown',null)),'');
});


import {lenderStateWord} from './view-models.mjs';
test('the job page pill uses the same word as the Jobs list for the same lender job', () => {
  const startedAt = '2026-10-19T15:00:00Z';
  const working = {role:'ran',state:'running',approval:'approved',
    current_attempt:{attempt_id:'a1',generation:1,state:'active',approved_at:'2026-10-19T14:59:00Z',execution_started_at:startedAt}};
  assert.equal(jobStateKey(working),'working','fixture is a running lender job');
  assert.equal(jobVM(working,'ran').word,'Running');
  assert.equal(jobStatusVM(working,{role:'ran'}).pill.word,jobVM(working,'ran').word);
  assert.equal(jobStatusVM({...working,role:'sent'},{role:'sent'}).pill.word,'Working','the requester still sees Working');
  const starting = {role:'received',state:'starting',approval:'approved',
    current_attempt:{attempt_id:'a1',generation:1,state:'active',approved_at:'2026-10-19T14:59:00Z'}};
  assert.equal(jobStateKey(starting),'starting');
  assert.equal(jobVM(starting,'received').word,'Preparing');
  assert.equal(jobStatusVM(starting,{role:'received'}).pill.word,jobVM(starting,'received').word);
  assert.equal(jobStatusVM({...starting,role:'sent'},{role:'sent'}).pill.word,'Starting','the requester still sees Starting');
});

test('lender words for sending and delayed delivery are one word for list and page', () => {
  // The job projection does not produce these two keys today; the shared word keeps the list and page aligned if it does.
  for (const key of ['sending','delivery_delayed']) assert.equal(lenderStateWord('ran',key),'Result not sent yet',key);
  assert.equal(lenderStateWord('ran','working'),'Running');
  assert.equal(lenderStateWord('received','starting'),'Preparing');
  assert.equal(lenderStateWord('sent','working'),undefined,'the sent role keeps Working');
  assert.equal(lenderStateWord('ran','starting'),undefined,'a lender who started the job still sees Starting');
});

test('Home distinguishes computers belonging to the same person',()=>{
 const rows=homePeopleVM([{key_id:'a',personName:'Tessa',device_name:'sandpiper'},{key_id:'b',personName:'Tessa',device_name:'kestrel'}]);
 assert.match(rows[0].state,/sandpiper/);assert.match(rows[1].state,/kestrel/);
});

test('Home keeps a confirmed same-circle running holder ahead of fresh presence',()=>{
 const member={key_id:'lender',personName:'Ana',presence:{source:'heartbeat',state:'off',last_heartbeat_at:new Date(now-1000).toISOString()}};
 const current={state:'claimed',circle:'weekend',current_attempt:{attempt_id:'attempt-1',generation:1,
  holder:'lender',state:'active',execution_started_at:new Date(now-3000).toISOString(),
  execution_observed_at:new Date(now-2000).toISOString()}};
 const render=(job,observation='current')=>homePeopleVM([member],{now,zone:'UTC',circleId:'weekend',
  jobs:[{...job,jobProjection:qualifyJobProjection(adaptLegacyJob(job),{state:observation})}]})[0].state;
 assert.deepEqual({
  running:render(current),
  otherCircle:render({...current,circle:'other'}),
  otherHolder:render({...current,current_attempt:{...current.current_attempt,holder:'other'}}),
  lastKnown:render(current,'last_known'),
  transitional:render(current,'transitional'),
  startOnly:render({...current,current_attempt:{...current.current_attempt,execution_observed_at:null}}),
 },{running:'Running a job now',otherCircle:'Not lending',otherHolder:'Not lending',
  lastKnown:'Not lending',transitional:'Not lending',startOnly:'Not lending'});
});

test('Lending off explains its hold once across both agents',()=>{
 const status=withLendingProjection({lending:{enabled:false}},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'});
 const rows=lendingQuotaLinesVM({accounts:[{provider:'claude'},{provider:'codex'}]},false,status);
 assert.deepEqual(rows,[{key:'off',label:'Lending off',text:'No new jobs start; running jobs continue within their saved limits.'}]);
});

test('detail headings expand only the automatically shortened request title',()=>{
 const line='Review all changed files and explain each command, failure case and recovery step without cutting this title short.';
 const preview=[...line].slice(0,79).join('')+'…';
 assert.equal(jobHeadingVM({local:{prompt:line,title:preview}},preview),line);
 assert.equal(jobHeadingVM({local:{prompt:line,title:'My edited title'}},'My edited title'),'My edited title');
 assert.equal(jobHeadingVM({},'Known title'),'Known title');
});


test('apply preview names the submitted branch without showing commit hashes',()=>{
  const vm=applyPreviewVM({...summary,current_branch:'refs/heads/feature/current'}, {sourceBranch:'refs/heads/feature/source'});
  assert.equal(vm.starts,'It starts from the version of feature/source you sent. Your current branch (feature/current) and your local changes are not touched.');
  assert.doesNotMatch(vm.starts,/8d01e4a|refs\/heads|[0-9a-f]{40}/);
  assert.equal(appliedLineVM({branch:'refs/heads/feature/result'}).heading,'Added as branch feature/result');
  const fallback=applyPreviewVM({...summary,current_branch:null},{sourceBranch:''});
  assert.equal(fallback.starts,'It starts from the version you sent. Your current files and your local changes are not touched.');
});

test('machine chip distinguishes blocked lending from a job decision that needs you', () => {
  const blocked = withLendingProjection({...status, attention:[{}]},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'sandbox_cannot_start'});
  const context = {readiness:{ready:true,checks:[]},agents:[{id:'codex',useForLending:true,installed:true,signedIn:true}], now};
  const waiting = machineVM(blocked, {}, context);
  assert.deepEqual([waiting.line, waiting.kind, waiting.word], ['Lending is blocked', 'wait', 'Waiting']);
  const action = machineVM(blocked, {}, {...context, approvals:[card]});
  assert.deepEqual([action.line, action.kind, action.word], ['Needs you', 'need', 'Needs you']);
});
