import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentActivity} from './transcript-feed.jsx';
import {JobStatusCard} from './job-view.jsx';
import {transcriptFeedVM} from './transcript-feed.mjs';
import {jobStatusVM} from './view-models.mjs';
import {RUNNING_CLAUDE, FINISHED_CLAUDE} from './fixtures/transcript-stream.mjs';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';

const zone = 'America/Chicago';
const running = transcriptFeedVM(RUNNING_CLAUDE, {live: true, truncated: true, zone});
const stuckLooking = running.lastAt + 291_000;
const finished = transcriptFeedVM(FINISHED_CLAUDE, {zone});

test('the activity feed: open while live, a chevron disclosure, no checkbox, no apology caption', () => {
  const out = renderFixture(AgentActivity, {feed: running, live: true, version: 1, empty: 'Nothing yet', now: running.lastAt,
    freshness: {connected:true, observedAt:running.lastAt, validUntil:running.lastAt+1000}});
  assert.match(withoutMaskMarkers(out), /<details class="card activity" open/);
  assert.match(out, /<summary class="activity-head"><svg class="i sm activity-chev"[^>]*><use href="#chev-r"><\/use><\/svg><h2 class="t-title3">What the agent is doing<\/h2><span class="activity-live">/);
  assert.doesNotMatch(out, /type="checkbox"|Follow latest|Earlier lines may be omitted|Agent transcript/);
  assert.doesNotMatch(out, /<pre[^>]*class="[^"]*transcript/, 'the agent’s words are not a terminal');
  assert.match(renderedText(out), /^What the agent is doing Live Last agent update 0 min ago · Last visible output 0 min ago Earlier steps aren’t shown I’ll check/);
});

test('messages are paragraphs with code spans; tools are rows with a verb and a monospace target whose full text is its title', () => {
  const out = renderFixture(AgentActivity, {feed: finished, live: false, version: 1, empty: ''});
  assert.match(withoutMaskMarkers(out), /<li class="feed-entry feed-msg"><div class="result-prose agent-markdown"><p>The bug: <code>sum<\/code> used <code>a - b<\/code>/);
  assert.match(out, /<span class="feed-verb">Ran<\/span><code class="feed-target" title="node --test sum.test.mjs">node --test sum.test.mjs<\/code>/);
  assert.match(out, /<span class="feed-verb">Edited<\/span><code class="feed-target" title="sum.mjs">sum.mjs<\/code>/);
  assert.doesNotMatch(withoutMaskMarkers(out), /<details class="card activity" open/, 'a finished job starts closed');
});

test('agent messages render safe Markdown while keeping fenced whitespace and suppressing unsafe links and images',()=>{
 const feed=transcriptFeedVM(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'# **Done**\n\n- `fixed`\n\n```text\n  +---+\n```\n\n![pixel](https://tracker.test/p.png) [bad](javascript:alert(1))'}}));
 const out=renderFixture(AgentActivity,{feed,live:false,version:1,empty:''});
 assert.match(out,/<h3><strong>Done<\/strong><\/h3>/);
 assert.match(out,/<li><p><code>fixed<\/code><\/p><\/li>/);
 assert.match(out,/<pre tabindex="0"><code>  \+---\+/);
 assert.doesNotMatch(out,/<img|href="javascript:/);
});

test('output sits collapsed under its row; a failed command is marked; an unfinished start has its age, not a liveness spinner', () => {
  const out = renderFixture(AgentActivity, {feed: running, live: true, version: 1, empty: '', now: stuckLooking});
  assert.match(withoutMaskMarkers(out), /<li class="feed-entry feed-tool is-error"><details class="feed-more"><summary class="feed-row"[^>]*>.*?href="#x-circle".*?Failed/);
  assert.doesNotMatch(out, /<details class="feed-more" open/);
  assert.match(out, /<pre class="feed-output" tabindex="0">Traceback/);
  assert.match(withoutMaskMarkers(out), /<li class="feed-entry feed-tool is-running"><div class="feed-row"><span class="feed-icon"><svg[^>]*>.*?href="#terminal".*?<code class="feed-target" title="cd \/tmp &amp;&amp; time \/tmp\/mandel_venv\/bin\/python mandelbrot_cel.py">.*?<span class="feed-meta">Started 4 min ago<\/span>.*?<p class="feed-quiet">No update for 4 min\. Current activity is unconfirmed\.<\/p>/);
  assert.doesNotMatch(out, /class="spinner"|Still running|feed-quiet" role="status"/);
  assert.match(withoutMaskMarkers(out), /<time class="feed-time" title="6:19:04 AM">6:19 AM<\/time>/);
});

test('an empty feed says so in words', () => {
  const out = renderFixture(AgentActivity, {feed: transcriptFeedVM(''), live: true, version: 0, empty: 'The agent hasn’t reported anything yet.'});
  assert.match(renderedText(out), /What the agent is doing Last agent update unavailable · Last visible output unavailable The agent hasn’t reported anything yet\./);
  assert.doesNotMatch(out, /activity-live/);
});

test('a live feed without a freshness claim still shows the observed start and time limit, but no headline or Live pill', () => {
  // The lender reports start and limit times as observations. The live headline needs a freshness claim, which the page never has.
  const out = renderFixture(AgentActivity, {feed: running, live: true, version: 1, empty: '', now: running.lastAt,
    headline: 'G2 agent is working on it', facts: ['Started 6:19 AM (2 min ago) · Time limit 6:39 AM']});
  assert.match(renderedText(out), /Started 6:19 AM.*Time limit 6:39 AM/);
  assert.doesNotMatch(renderedText(out), /G2 agent is working on it/);
  assert.doesNotMatch(out, /activity-live/);
});

test('the status card names the command the agent is running, in monospace, with the full command as its title', () => {
  const vm = jobStatusVM({state: 'claimed', current_attempt: {holder: 'k', execution_started_at: '2026-10-20T11:19:00Z'}, runTiming: {hardStopAt: '2026-10-20T11:39:00Z'}},
    {now: Date.parse('2026-10-20T11:19:38Z'), zone, progress: [{seq: 1, at: 'x', stage: 'agent', elapsed_s: 12}], activity: running.activity});
  const later = jobStatusVM({state: 'claimed', current_attempt: {holder: 'k', execution_started_at: '2026-10-20T11:19:00Z'}},
    {now: stuckLooking, zone, progress: [], activity: running.activity});
  assert.match(renderedText(renderFixture(JobStatusCard, {vm: later})), /Agent working · started running cd \/tmp &&.*mandelbrot_cel\.py for 4:51/);
  const out = renderFixture(JobStatusCard, {vm});
  assert.match(renderedText(out), /Started 6:19 AM.*Time limit 6:39 AM/);
  assert.doesNotMatch(out, /just now|stops by|running \d+ min/);
  assert.match(out, /Agent working · started running<\/span><code class="prog-code" title="cd \/tmp &amp;&amp; time \/tmp\/mandel_venv\/bin\/python mandelbrot_cel.py">/);
});

test('an older lender shows an honest availability note without an empty Live feed', () => {
  const out=renderFixture(AgentActivity,{feed:transcriptFeedVM(''),live:false,unavailable:'lender_version'});
  assert.match(renderedText(out),/Live activity isn’t available from this lender’s version/);
  assert.doesNotMatch(out, /activity-live|<details|hasn’t reported/);
});

test('an older host is named separately from the lender', () => {
  const out=renderFixture(AgentActivity,{feed:transcriptFeedVM(''),live:false,unavailable:'host_version'});
  assert.match(renderedText(out),/Live activity isn’t available with this host’s version/);
});

test('plain-text legacy transcripts preserve fenced art and render Markdown',()=>{
 const text='**Poem**\n\n```text\n  /\\_/\\\n\n ( o.o )\n```';
 const feed=transcriptFeedVM(text);
 const html=renderFixture(AgentActivity,{feed,live:true,now:0});
 assert.match(html,/<strong>Poem<\/strong>/);
 assert.match(html,/<code>  \/\\_\/\\\n\n \( o.o \)/);
});
test('legacy fenced JSON and standalone Markdown links are text, not transcript events',()=>{
 const text='```json\n{"state":"done"}\n```\n\n[Source](https://example.com)';
 const feed=transcriptFeedVM(text);
 assert.equal(feed.entries[0].text,text);
 const html=renderFixture(AgentActivity,{feed,live:false,now:0});
 assert.match(html,/href="https:\/\/example.com"/);
});

test('lender fallback speaks about this job rather than a remote lender',()=>{
 const out=renderFixture(AgentActivity,{feed:transcriptFeedVM(''),live:false,unavailable:'lender_version',viewer:'ran'});
 assert.match(renderedText(out),/Live activity isn’t shown for this job/);
 assert.doesNotMatch(renderedText(out),/this lender’s version/);
});

test('withheld output is one quiet note, never an assistant message or literal filler',()=>{
 const withheld=JSON.stringify({type:'transcript.withheld',omitted:true})+'\n';
 const legacy=JSON.stringify({type:'assistant',omitted:true,message:{content:[{type:'text',text:'[private details withheld]'}]}})+'\n';
 const feed=transcriptFeedVM(withheld.repeat(10)+legacy.repeat(10));
 const out=renderFixture(AgentActivity,{feed,live:true});
 assert.equal(feed.entries.length,1);
 assert.match(withoutMaskMarkers(out),/class="feed-entry feed-withheld t-sm t-2" role="note"/);
 assert.match(renderedText(out),/Output was withheld because it may contain private details/);
 const mixed=transcriptFeedVM(withheld+JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Safe progress'}]}}));
 assert.match(renderedText(renderFixture(AgentActivity,{feed:mixed,live:true})),/Some output was withheld because it may contain private details/);
 assert.doesNotMatch(out,/feed-msg|\[private details withheld\]/);
});

test('post-filter wire records render muted omissions, named file rows and unchanged assistant words', () => {
  const hidden = {type: 'transcript.withheld', omitted: true, reason: 'private details withheld'};
  const records = [
    hidden, hidden,
    {type: 'system', subtype: 'init', omitted: true},
    {type: 'system', subtype: 'task_started', omitted: true},
    {type: 'heartbeat', omitted: true},
    {type: 'assistant', omitted: true, message: {content: [{type: 'text', text: '[private details withheld]'}]}},
    {type: 'assistant', message: {content: [{type: 'text', text: 'I’ll check `src/sum.mjs`, then run the tests.'}]}},
    ...['Read', 'Edit', 'Write'].map((name, index) => ({
      type: 'assistant', message: {content: [{type: 'tool_use', id: 'file-' + index, name,
        input: {file_path: 'src/' + name.toLowerCase() + '.mjs', path: 'src/' + name.toLowerCase() + '.mjs'}}]},
    })),
    // A long shell invocation arrives as this allow-listed label, not the original command.
    {type: 'assistant', message: {content: [{type: 'tool_use', id: 'command', name: 'Bash', input: {command: 'npm test'}}]}},
    hidden, hidden,
  ];
  for (const live of [false, true]) {
    const feed = transcriptFeedVM(records.map(record => JSON.stringify(record)).join('\n'), {live, zone});
    const out = renderFixture(AgentActivity, {feed, live, version: 1, empty: ''});
    assert.equal((withoutMaskMarkers(out).match(/class="feed-entry feed-msg"/g) || []).length, 1);
    assert.match(out, /<p>I’ll check <code>src\/sum.mjs<\/code>, then run the tests\.<\/p>/);
    for (const [verb, path] of [['Started reading', 'src/read.mjs'], ['Started editing', 'src/edit.mjs'], ['Started writing', 'src/write.mjs'], ['Started running', 'npm test']]) {
      assert.ok(out.includes('<code class="feed-target" title="' + path + '">' + path + '</code>'), path);
      assert.ok(out.includes('<span class="feed-verb">' + verb + '</span>'), verb);
      if (!live) assert.match(out, /Outcome not recorded/);
    }
    const notes = withoutMaskMarkers(out).match(/<li class="feed-entry feed-withheld t-sm t-2" role="note">Some output was withheld because it may contain private details<\/li>/g) || [];
    assert.ok(notes.length >= 1 && notes.length <= 2, 'at most one muted note for each of the two omission runs');
    assert.equal(notes.length, (out.match(/feed-withheld/g) || []).length);
    assert.doesNotMatch(out, /\[private details withheld\]|\/tmp\/wf-job-|\/workspace\/|\/Users\/|\/home\//);
  }
});

test('R4 unchanged fresh polls and cached transcripts never label record time as host contact',()=>{
 const now=Date.parse('2026-10-31T09:10:00Z');
 const feed=transcriptFeedVM(JSON.stringify({type:'heartbeat',timestamp:'2026-10-31T09:00:00Z'}),{live:true});
 for(const freshness of [{connected:true,observedAt:now,validUntil:now+60000},undefined]){
  const out=renderFixture(AgentActivity,{feed,live:true,now,freshness,empty:'No output yet'});
  assert.match(renderedText(out),/Last agent update 10 min ago/);
  assert.doesNotMatch(renderedText(out),/Last host contact/);
 }
 const empty=renderedText(renderFixture(AgentActivity,{feed:transcriptFeedVM(''),live:true,now,freshness:{connected:true,observedAt:now,validUntil:now+60000}}));
 assert.match(empty,/Last agent update unavailable/);assert.doesNotMatch(empty,/Last host contact/);
});
