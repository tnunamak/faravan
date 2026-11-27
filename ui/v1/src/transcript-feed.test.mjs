import test from 'node:test';
import assert from 'node:assert/strict';
import {liveFreshness, LIVE_ACTIVITY_WINDOW_MS, transcriptFeedVM, followVM, atBottom, messageParts, durationLabel, runningVM, elapsedTime, jobTimingLine, toolLabel, feedFreshness, feedEvidenceLabels, feedAnnouncement, statusLastOutputAt} from './transcript-feed.mjs';
import {RUNNING_CLAUDE, FINISHED_CLAUDE, CODEX} from './fixtures/transcript-stream.mjs';

const zone = 'America/Chicago';
const kinds = feed => feed.entries.map(e => e.kind === 'tool' ? e.verb + ' ' + e.target : e.kind);

test('Claude stream-json becomes messages and tool rows; thinking, heartbeats and init stay out', () => {
  const feed = transcriptFeedVM(RUNNING_CLAUDE, {live: true, zone});
  assert.deepEqual(kinds(feed), [
    'message',
    'Ran python3 -c "import numpy, PIL; print(numpy.__version__, PIL.__version__)"',
    'message',
    'Ran python3 -m venv /tmp/mandel_venv && /tmp/mandel_venv/bin/pip install --quiet numpy pillow && /tmp/mandel_venv/bin/python -c "import numpy, PIL; print(numpy.__version__, PIL.__version__)"',
    'message',
    'Wrote mandelbrot_cel.py',
    'Read README.md',
    'Searched BANDS',
    'message',
    'Edited mandelbrot_cel.py',
    'Ran cd /tmp && time /tmp/mandel_venv/bin/python mandelbrot_cel.py',
  ]);
  assert.equal(feed.entries[0].text.startsWith('I’ll check what’s available'), true);
});

test('command output is kept under its row; a failed tool is an error; read and edit output stays quiet', () => {
  const feed = transcriptFeedVM(RUNNING_CLAUDE, {live: true, zone});
  const [check, install] = feed.entries.filter(e => e.tool === 'Bash');
  assert.equal(check.error, true);
  assert.match(check.output, /ModuleNotFoundError/);
  assert.equal(install.error, false);
  assert.equal(install.output, '2.3.4 12.0.0');
  assert.equal(install.took, '21s');
  assert.equal(feed.entries.find(e => e.tool === 'Read').output, '');
  assert.equal(feed.entries.find(e => e.tool === 'Edit').output, '');
  assert.equal(feed.entries.find(e => e.tool === 'Grep').output, 'mandelbrot_cel.py');
});

test('the job folder is stripped from paths and outputs', () => {
  const feed = transcriptFeedVM(FINISHED_CLAUDE, {zone});
  const find = feed.entries[0];
  assert.equal(find.target, 'find . -iname "sum*" -not -path "*/node_modules/*"');
  assert.equal(find.output, 'sum.test.mjs\nsum.mjs');
  assert.equal(feed.entries.find(e => e.tool === 'Read').target, 'sum.mjs');
});

test('the last command is still running while live; its heartbeat gives elapsed seconds; activity names it', () => {
  const feed = transcriptFeedVM(RUNNING_CLAUDE, {live: true, zone});
  const last = feed.entries.at(-1);
  assert.deepEqual([last.running, last.seconds], [true, 60]);
  assert.deepEqual([feed.activity.doing, feed.activity.code], ['started running', 'cd /tmp && time /tmp/mandel_venv/bin/python mandelbrot_cel.py']);
  assert.equal(feed.entries.filter(e => e.running).length, 1);
});

test('a finished transcript has nothing running and no activity; a result that repeats the last message is not doubled', () => {
  const feed = transcriptFeedVM(FINISHED_CLAUDE, {zone});
  assert.equal(feed.entries.some(e => e.running), false);
  assert.equal(feed.activity, null);
  assert.equal(feed.entries.filter(e => e.kind === 'message').length, 2);
  assert.equal(feed.entries.at(-1).kind, 'message');
});

test('a failed result is an error entry', () => {
  const feed = transcriptFeedVM(JSON.stringify({type: 'result', subtype: 'error_max_turns', is_error: true, result: ''}));
  assert.deepEqual(feed.entries.map(e => [e.kind, e.error, e.text]), [['text', true, 'The agent stopped with an error.']]);
});

test('Codex item events: messages, commands with exit codes, file changes', () => {
  const feed = transcriptFeedVM(CODEX, {zone});
  assert.deepEqual(kinds(feed), ['message', 'Ran npm test', 'Edited src/sum.mjs']);
  const command = feed.entries[1];
  assert.deepEqual([command.error, command.output, command.running], [true, '1 failing', false]);
});

test('unknown lines fall back to wrapped text; consecutive lines join; broken JSON never shows', () => {
  const feed = transcriptFeedVM(['Starting the agent', 'on sandpiper', '{"type":"assistant","mess', JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'Done.'}}), 'bye'].join('\n'));
  assert.deepEqual(feed.entries.map(e => [e.kind, e.text]), [['text', 'Starting the agent\non sandpiper'], ['message', 'Done.'], ['text', 'bye']]);
});

test('a trimmed transcript drops its partial first line and says earlier steps are not shown', () => {
  const feed = transcriptFeedVM('Q55pXzyrjsY3yZsTtdOKEtahdYjVwa1VEBLiH","type":"image/png"}}}\n' + RUNNING_CLAUDE, {truncated: true, live: true, zone});
  assert.equal(feed.trimmed, true);
  assert.equal(feed.entries[0].kind, 'message');
});

test('times: every message shows its time, tool rows none; each entry has a full tooltip time', () => {
  const feed = transcriptFeedVM(RUNNING_CLAUDE, {live: true, zone});
  assert.equal(feed.entries[0].time, '6:19 AM');
  assert.equal(feed.entries[0].timeTitle, '6:19:04 AM');
  assert.ok(feed.entries.filter(e => e.kind === 'tool').every(e => e.time === ''));
  assert.ok(feed.entries.filter(e => e.kind === 'message').every(e => /^\d{1,2}:\d{2} [AP]M$/.test(e.time)));
});

test('message code spans and durations', () => {
  assert.deepEqual(messageParts('Fixed `sum.mjs:1` now'), [{text: 'Fixed ', code: false}, {text: 'sum.mjs:1', code: true}, {text: ' now', code: false}]);
  assert.deepEqual([durationLabel(400), durationLabel(21000), durationLabel(65000)], ['', '21s', '1:05']);
});

test('follow: at the bottom follows; scrolled up stops following and offers Jump to latest only while live', () => {
  const bottom = {scrollTop: 600, scrollHeight: 1000, clientHeight: 400};
  const up = {scrollTop: 200, scrollHeight: 1000, clientHeight: 400};
  assert.equal(atBottom({...bottom, scrollTop: 570}), true);
  assert.deepEqual(followVM(bottom, true), {following: true, jump: false});
  assert.deepEqual(followVM(up, true), {following: false, jump: true});
  assert.deepEqual(followVM(up, false), {following: false, jump: false});
});

test('a running command shows how long it has run, ticking with the clock, and says calmly when output has gone quiet', () => {
  const feed = transcriptFeedVM(RUNNING_CLAUDE, {live: true, zone});
  const last = feed.entries.at(-1), started = last.at;
  assert.equal(feed.lastAt, started, 'the newest timed line is the command itself');
  assert.deepEqual(runningVM(last, {now: started + 45_000, lastAt: feed.lastAt}), {timer: 'Started 45 s ago', quiet: ''}, 'start age does not turn heartbeat elapsed into a start timestamp');
  assert.deepEqual(runningVM(last, {now: started + 291_000, lastAt: feed.lastAt}), {timer: 'Started 4 min ago', quiet: 'No update for 4 min. Current activity is unconfirmed.'});
  assert.equal(runningVM(last, {now: started + 61_000, lastAt: feed.lastAt}).quiet, 'No update for 1 min. Current activity is unconfirmed.');
  assert.equal(runningVM(last, {now: started + 60_000, lastAt: feed.lastAt}).quiet, '', 'a minute of quiet is normal');
  assert.deepEqual(feed.activity, {doing: 'started running', code: 'cd /tmp && time /tmp/mandel_venv/bin/python mandelbrot_cel.py', since: started, seconds: 60});
});

test('job timing uses the transcript elapsed formatter for queue age, run time, cap and quiet output', () => {
  const now = Date.parse('2026-10-19T20:05:00Z');
  assert.equal(elapsedTime(125), '2:05');
  assert.equal(jobTimingLine({now, startedAt:now, zone:'UTC'}), 'Started 8:05 PM (0 s ago)');
  assert.equal(jobTimingLine({now, startedAt:now-660000, zone:'UTC'}), 'Started 7:54 PM (11 min ago)');
  assert.equal(jobTimingLine({now, queuedAt:'2026-10-19T20:00:00Z', zone:'UTC'}), 'Waiting 5 min');
  assert.equal(jobTimingLine({now, queuedAt:now, zone:'UTC'}), 'Waiting under 1 min');
  assert.equal(jobTimingLine({now, startedAt:now - 45_000, zone:'UTC'}), 'Started 8:04 PM (45 s ago)');
  assert.equal(jobTimingLine({now, startedAt:'2026-10-19T20:00:00Z', stopsAt:'2026-10-19T20:20:00Z', lastOutputAt:'2026-10-19T20:02:00Z', zone:'UTC'}),
    'Started 8:00 PM (5 min ago) · Time limit 8:20 PM · Last visible output 3 min ago');
});

test('the header reports visible-output evidence, never snapshot contact',async()=>{
 const {statusLastOutputAt}=await import('./transcript-feed.mjs');
 const at=Date.parse('2026-10-20T11:19:12Z');
 assert.equal(statusLastOutputAt({entries:[{kind:'withheld'}],lastAt:null},at),at);
 assert.equal(statusLastOutputAt({entries:[{kind:'withheld'}],lastAt:null},null,new Date(at).toISOString()),null);
 assert.equal(statusLastOutputAt({entries:[{kind:'withheld'}],lastAt:null},null,undefined),null);
 assert.equal(statusLastOutputAt({entries:[{kind:'message'}],lastAt:at},at),at);
 assert.equal(statusLastOutputAt({entries:[{kind:'tool',running:true,at:null,seconds:null}],lastAt:null},at),at);
 assert.equal(statusLastOutputAt({entries:[{kind:'tool',running:true,at,seconds:null}],lastAt:at},at),at);
});

const wire = records => records.map(record => JSON.stringify(record)).join('\n');
const withheldWire = {type: 'transcript.withheld', omitted: true, reason: 'private details withheld'};

test('post-filter omission runs never become messages or literal filler', () => {
  const words = 'I’ll check `src/sum.mjs`.\n\nThen run the tests.';
  const omitted = [
    withheldWire,
    {type: 'assistant', omitted: true, message: {content: [{type: 'text', text: '[private details withheld]'}]}},
    {type: 'result', omitted: true, result: '[private details withheld]'},
    {type: 'item.completed', omitted: true, item: {type: 'agent_message', text: '[private details withheld]'}},
  ];
  for (const live of [false, true]) {
    const feed = transcriptFeedVM(wire([
      ...omitted, ...omitted,
      {type: 'assistant', message: {content: [{type: 'text', text: words}]}},
      ...omitted,
    ]), {live, zone});
    assert.deepEqual(feed.entries.filter(entry => entry.kind !== 'withheld').map(entry => [entry.kind, entry.text]), [['message', words]]);
    let notesInRun = 0;
    for (const entry of feed.entries) {
      if (entry.kind !== 'withheld') { notesInRun = 0; continue; }
      assert.ok(++notesInRun <= 1, 'a run of omitted records has at most one note');
      assert.equal(entry.text, 'Some output was withheld because it may contain private details');
    }
    assert.doesNotMatch(JSON.stringify(feed), /\[private details withheld\]/);
  }
});

test('post-filter system, task-start and heartbeat metadata never become message rows', () => {
  // Current projection drops unknown metadata; older filtered streams may retain these envelopes.
  const metadata = [
    {type: 'system', subtype: 'init'},
    {type: 'system', subtype: 'task_started'},
    {type: 'task-start'},
    {type: 'heartbeat'},
    {type: 'tool_progress', parent_tool_use_id: 'not-visible', elapsed_time_seconds: 30},
  ];
  assert.deepEqual(transcriptFeedVM(wire(metadata), {live: true, zone}).entries, []);
  const feed = transcriptFeedVM(wire(metadata.map(event => ({...event, omitted: true}))), {live: true, zone});
  assert.ok(feed.entries.length <= 1);
  assert.ok(feed.entries.every(entry => entry.kind === 'withheld' && entry.text === 'Output was withheld because it may contain private details'));
});

test('post-filter Claude tools keep only relative filenames and the allow-listed command label', () => {
  // Deliberately use the wire projection, without cwd, file contents, edits, or the original long command.
  const records = ['Read', 'Edit', 'Write'].map((name, index) => ({
    type: 'assistant',
    message: {content: [{type: 'tool_use', id: 'file-' + index, name,
      input: {file_path: 'src/' + name.toLowerCase() + '.mjs', path: 'src/' + name.toLowerCase() + '.mjs'}}]},
  }));
  records.push({type: 'assistant', message: {content: [
    {type: 'tool_use', id: 'command', name: 'Bash', input: {command: 'npm test'}},
  ]}});
  for (const live of [false, true]) {
    const feed = transcriptFeedVM(wire(records), {live, zone});
    assert.deepEqual(kinds(feed), ['Read src/read.mjs', 'Edited src/edit.mjs', 'Wrote src/write.mjs', 'Ran npm test']);
    assert.deepEqual(feed.entries.map(entry => entry.full), ['src/read.mjs', 'src/edit.mjs', 'src/write.mjs', 'npm test']);
    assert.ok(feed.entries.every(entry => entry.output === ''));
    assert.doesNotMatch(JSON.stringify(feed), /\/tmp\/wf-job-|\/workspace\/|\/Users\/|\/home\//);
    if (live) assert.equal(feed.activity.code, 'npm test');
  }
});

test('post-filter Codex command and file-change projections retain their safe targets', () => {
  const words = 'Updated `src/sum.mjs`; tests pass.';
  const feed = transcriptFeedVM(wire([
    withheldWire,
    {type: 'item.completed', item: {id: 'command', type: 'command_execution', command: 'npm test', exit_code: 0}},
    {type: 'item.completed', item: {id: 'edit', type: 'file_change', changes: [{path: 'src/sum.mjs'}]}},
    {type: 'item.completed', item: {id: 'message', type: 'agent_message', text: words}},
  ]), {zone});
  assert.deepEqual(kinds(feed), ['withheld', 'Ran npm test', 'Edited src/sum.mjs', 'message']);
  assert.equal(feed.entries[1].output, '');
  assert.equal(feed.entries[1].error, false);
  assert.equal(feed.entries.at(-1).text, words);
  assert.doesNotMatch(JSON.stringify(feed), /\/tmp\/wf-job-|\/workspace\/|\/Users\/|\/home\//);
});

test('the Live claim needs a live transcript read inside the freshness window', () => {
  const at = Date.parse('2026-10-20T15:00:00Z');
  assert.equal(feedFreshness(liveFreshness({connected: true, observedAt: at}), at + LIVE_ACTIVITY_WINDOW_MS), true, 'the window is inclusive');
  assert.equal(feedFreshness(liveFreshness({connected: true, observedAt: at}), at + LIVE_ACTIVITY_WINDOW_MS + 1), false, 'a read older than the window is not live');
  assert.equal(feedFreshness(liveFreshness({connected: false, observedAt: at}), at), false, 'a dropped connection is not live');
  assert.equal(feedFreshness(liveFreshness({connected: true, observedAt: undefined}), at), false, 'no read yet, no live claim');
});
test('F1 frozen snapshots never claim execution or a guaranteed stop', () => {
  const now=120000;
  assert.equal(feedFreshness({connected:true,observedAt:0,validUntil:60000},now),false);
  assert.equal(feedFreshness(undefined,now),false);
  assert.equal(feedFreshness({connected:true,observedAt:now,validUntil:now+60000},now),true);
  assert.equal(runningVM({at:0},{now,lastAt:0}).quiet,'No update for 2 min. Current activity is unconfirmed.');
  assert.equal(runningVM({at:0},{now}).timer,'Started 2 min ago');
  assert.doesNotMatch(jobTimingLine({now,startedAt:0,stopsAt:300000,zone:'UTC'}),/running|stops by/);
});
test('F2 terminal tool starts are unknown, while matching success and failure differ', () => {
  const start={type:'assistant',message:{content:[{type:'tool_use',id:'w',name:'Write',input:{file_path:'x.txt'}}]}};
  const unknown=transcriptFeedVM(wire([start])).entries[0];
  assert.equal(unknown.running,false);assert.equal(unknown.completed,false);
  assert.equal(toolLabel(unknown),'Started writing');
  for(const error of [false,true]){
    const entry=transcriptFeedVM(wire([start,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'w',is_error:error,content:'result'}]}}])).entries[0];
    assert.equal(entry.completed,true);assert.equal(entry.error,error);
    assert.equal(toolLabel(entry),error?'Failed while writing':'Wrote');
  }
});
test('F3 orphan results retain safe errors without inventing their missing start', () => {
  const result=content=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:'missing',is_error:true,content}]}});
  const feed=transcriptFeedVM(wire([result('Permission denied')]),{truncated:true});
  const entry=feed.entries[0];assert.equal(entry.output,'Permission denied');assert.equal(entry.error,true);
  assert.equal(toolLabel(entry),'Tool result — earlier step unavailable');assert.equal(entry.target,'');
  const privateFeed=transcriptFeedVM(wire([result('[private details withheld]')]),{truncated:true});
  assert.equal(privateFeed.entries[0].kind,'withheld');assert.doesNotMatch(JSON.stringify(privateFeed),/\[private details withheld\]/);
});
test('F5 metadata updates contact independently of visible output and withholds private events', () => {
  const feed=transcriptFeedVM(wire([
    {type:'assistant',timestamp:'1970-01-01T00:00:01Z',message:{content:[{type:'text',text:'Hello'}]}},
    {type:'heartbeat',timestamp:'1970-01-01T00:02:00Z'},
    {type:'assistant',omitted:true,timestamp:'1970-01-01T00:03:00Z',message:{content:[{type:'text',text:'private-secret'}]}},
  ]));
  assert.equal(statusLastOutputAt(feed,240000),1000);
  assert.equal(feed.lastContactAt,180000);assert.equal(feed.lastVisibleOutputAt,1000);
  assert.deepEqual(feedEvidenceLabels(feed,241000),['Last agent update 1 min ago','Last visible output 4 min ago']);
  assert.doesNotMatch(JSON.stringify(feed),/private-secret/);
});
test('F6 only meaningful feed transitions announce, not repeated clock ticks', () => {
  const previous={connected:true,question:false,output:'a'};
  assert.equal(feedAnnouncement(previous,{...previous}),'');
  assert.equal(feedAnnouncement(previous,{...previous,output:'b'}),'New agent output available');
  assert.equal(feedAnnouncement(previous,{...previous,question:true}),'The run ended with a question');
  assert.equal(feedAnnouncement(previous,{...previous,connected:false}),'Connection lost');
});

test('R5 started step ages use explicit units across the minute boundary',()=>{
 for(const [seconds,expected] of [[0,'0 s'],[59,'59 s'],[60,'1 min'],[291,'4 min']])
  assert.equal(runningVM({at:0},{now:seconds*1000}).timer,'Started '+expected+' ago');
});

test('redacted matching results preserve completion and error without exposing payload or advancing visible output',()=>{
 const start={type:'assistant',timestamp:'1970-01-01T00:00:01Z',message:{content:[{type:'tool_use',id:'redacted',name:'Bash',input:{command:'npm test'}}]}};
 for(const live of [false,true])for(const is_error of [false,true])for(const withheld of [{content:'[private details withheld] secret'},{omitted:true,content:'secret'}]){
  const feed=transcriptFeedVM(wire([start,{type:'user',timestamp:'1970-01-01T00:00:02Z',message:{content:[{type:'tool_result',tool_use_id:'redacted',is_error,...withheld}]}}]),{live,zone});
  const tool=feed.entries[0];
  assert.equal(tool.completed,true);assert.equal(tool.running,false);assert.equal(tool.error,is_error);assert.equal(tool.output,'');
  assert.equal(toolLabel(tool),is_error?'Failed while running':'Ran');
  assert.ok(feed.entries.some(entry=>entry.kind==='withheld'));
  assert.equal(feed.lastVisibleOutputAt,1000);
  assert.doesNotMatch(JSON.stringify(feed),/secret|\[private details withheld\]/);
 }
});
test('Claude text keeps author role and a user echo does not suppress the agent result',()=>{
 const feed=transcriptFeedVM(wire([
  {type:'assistant',message:{content:[{type:'text',text:'Working'}]}},
  {type:'user',message:{content:[{type:'text',text:'Please update the README'}]}},
  {type:'result',result:'Please update the README'},
 ]),{zone});
 assert.deepEqual(feed.entries.slice(0,2).map(entry=>entry.role),['assistant','user']);
 assert.equal(feed.entries.length,3);
});
