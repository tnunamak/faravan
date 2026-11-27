import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runV1Command, statusMessage, waitingLine, problemForError, createJobOperations, presenceLine, failureVM } from '../lib/v1/cli.mjs';
import { classify } from '../lib/v1/failures.mjs';
import { LAN_WARNING } from '../lib/protocol/index.mjs';
import { fixture } from './helpers/v1-journey.mjs';
import { readFile } from 'node:fs/promises';
import { helpFor, topLevelUsage } from '../lib/v1/help.mjs';

const job = 'sha256:' + 'a'.repeat(64), now = Date.parse('2026-10-19T12:00:00Z');
async function run(argv, options = {}) {
  let stdout = '', stderr = '';
  const code = await runV1Command(argv, {...options,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});
  return {code,stdout,stderr};
}
test('U12 waiting copy uses pure presence, including heartbeat, old poll and unavailable data', () => {
  const viewer = {now,timeZone:'UTC',id:'self'};
  for (const presence of [{}, {approvalFor:'self'}, {waiting_reason:'all_declined'}, {basis:'recent-activity'}]) {
    const line = presenceLine(presence, viewer);
    assert.equal(waitingLine({presence}, viewer), (line==='Waiting'?line:'Waiting · '+line)+' · Check again shortly.');
  }
  const device = {device:'friend',source:'heartbeat',online:true,last_heartbeat_at:new Date(now-30000).toISOString(),intent:{state:'ready'}};
  assert.match(waitingLine({presence:{devices:[device]}},viewer),/computer is ready/);
  assert.match(waitingLine({presence:{devices:[{...device,intent:{state:'off'}}]}},viewer),/isn.t lending/);
  assert.match(waitingLine({presence:{devices:[{...device,last_heartbeat_at:new Date(now-120000).toISOString()}]}},viewer),/1 computer hasn.t checked in recently\. Another computer may still take this job\./);
  for (const intent of [null, device.intent]) {
    const polled = {...device, source:'poll', intent, last_poll_at:device.last_heartbeat_at};
    const line = waitingLine({presence:{devices:[polled]}}, viewer);
    assert.match(line, /checked in, but lending status is unconfirmed/);
    assert.doesNotMatch(line, /isn't lending|computer is ready/);
  }
  assert.match(waitingLine({presence:{devices:[{...device,online:false}]}},viewer),/1 computer hasn.t checked in recently\. Another computer may still take this job\./);
  assert.match(waitingLine({presence:{devices:[{...device,device:'self'}]}},viewer),/no other computers have reported availability/);
});
test('U12 failures use pure known copy, short IDs, and the approved cautious unknown fallback', () => {
  const view = {job_digest:job,state:'failed',current_attempt:{reason:'wall_timeout',execution_started_at:'2026-10-19T12:00:00Z'}};
  const message = statusMessage(view);
  assert.ok(message.includes(failureVM('wall_timeout','run').headline));
  assert.ok(message.includes(classify('wall_timeout','run',job).error_id));
  assert.match(message,/Code: wall_timeout/);
  for (const reason of ['future_failure','__proto__','constructor','PRIVATE ERROR /path',null]) {
    const text = statusMessage({...view,current_attempt:{reason}});
    assert.match(text,/^The action could not be completed\. Check the job status for details\./);
    assert.doesNotMatch(text,/try again|PRIVATE|SPK-|--again/);
  }
  const problem = problemForError(Object.assign(new Error('PRIVATE TOKEN'),{code:'future_failure'}));
  assert.match(problem.message,/^The action could not be completed\./);
  assert.doesNotMatch(JSON.stringify(problem),/PRIVATE|It will try again/);
});
test('lending conflicts return specific, actionable problem text', () => {
  assert.equal(problemForError(Object.assign(new Error('lending_busy'),{code:'lending_busy',status:409})).message,
    'Pause lending or stop the running job, then try again.');
  assert.equal(problemForError(Object.assign(new Error('circle_ambiguous'),{code:'circle_ambiguous',status:409})).message,
    'Choose the circle you want to lend to, then try again.');
});
test('CLI help and messages never pair pause with the current job', async () => {
  const copy = [topLevelUsage(), ...['host','run','stop','job','circle','lending','doctor'].map(command => helpFor([command]) ?? '')].join('\n');
  const source = await Promise.all(['../lib/v1/cli.mjs', '../lib/v1/ops/cli.mjs', '../lib/v1/help.mjs']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.doesNotMatch(copy + source.join('\n'), /pause.{0,50}current job|current job.{0,50}pause/i);
});
test('U12 join alias prints the LAN warning exactly once on acceptance, refusal and JSON', async () => {
  for (const json of [false,true]) for (const accepted of [false,true]) {
    let joined = 0;
    const device = {joinCircle:async(_link,opts)=>{
      await opts.onWarning(LAN_WARNING); joined++; return {name:'Friends',warning:LAN_WARNING,enrollment:{state:'approved'}};
    }};
    const result = await run(['join','link',...(accepted?['--accept-lan-warning']:[]),...(json?['--json']:[])],{device,stdin:new PassThrough()});
    assert.equal(result.code,accepted?0:2);
    assert.equal(joined,accepted?1:0);
    const text = json ? JSON.parse(result.stdout).warning ?? JSON.parse(result.stdout).message : result.stdout+result.stderr;
    assert.equal(text.split(LAN_WARNING).length-1,1);
    if(json) assert.equal(result.stderr,'');
  }
});
test('U12 stop aliases named and uniquely current jobs; old cancel form remains available', async () => {
  const calls = [], operations = {current:async input=>{assert.deepEqual(input,{circle:undefined});return {digest:job,circle:'friends'};},
    cancel:async input=>{calls.push(input);return {compute_stopped:false};}};
  for (const args of [['stop','aaaaaaaa'],['stop'],['job','cancel','aaaaaaaa']]) {
    const result = await run(args,{operations});
    assert.equal(result.code,0);assert.equal(result.stdout,'Stop requested\n');
  }
  assert.equal(calls[0].digest,'aaaaaaaa');assert.equal(calls[1].digest,job);assert.equal(calls[1].circle,'friends');
  assert.equal((await run(['stop','one','two'],{operations})).code,2);
});
test('U12 current job resolution refuses ambiguity and ignores other members and terminal jobs', async t => {
  const f = await fixture(t), own = {jobDigest:job,circle:'friends'}, sent={job:{payload:{author:'self'}}};
  let views = [{...sent,job_digest:job,state:'claimed'}];
  const device = {keyId:'self',listCircles:async()=>[{id:'friends',origin:'https://example.test'}],
    intentStore:()=>({list:async()=>[own]}),client:async()=>({async *listJobs(){yield* views;}})};
  const ops = createJobOperations({home:await f.home(),device});
  assert.deepEqual(await ops.current(),{digest:job,circle:'friends'});
  views = [{...sent,job_digest:job,state:'result-accepted'},{job:{payload:{author:'other'}},job_digest:job,state:'claimed'}];
  await assert.rejects(ops.current(),/No active job/);
  views = [{...sent,job_digest:job,state:'claimed'},{...sent,job_digest:job,state:'queued'}];
  await assert.rejects(ops.current(),/More than one job/);
});
test('U12 real dispatcher accepts join and stop help and the old forms', async t => {
  const f = await fixture(t);
  for(const args of [['join'],['stop'],['circle','join'],['job','cancel']]) {
    const result = await f.cli([...args,'--help']);
    assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes('Usage: faravan '+args.join(' ')));
  }
});
