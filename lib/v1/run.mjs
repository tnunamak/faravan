// `faravan run`: submit the current repository's HEAD and stream status until the job finishes.
import { execFile, spawn } from 'node:child_process';
import { lstat, realpath, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { UsageError, parse, createJobOperations, statusLabel, statusMessage, problemForError, problemText, exitCodeForError, confirmJobSend } from './cli.mjs';
import { ArchiveError } from '../archive.mjs';
import { filterSourceArchive } from '../source-filter.mjs';
import { changedFiles } from '../git-source-status.mjs';
import { openDevice } from './device.mjs';
import { shortId } from './job-id.mjs';
import { opById } from './ops/registry.mjs';
import { jobCircles, resolveJobRecipient } from './job-recipient.mjs';
import {createOpsClient, problemOf, exitCodeFor} from './ops/execute.mjs';
import {configHome} from '../local-state.mjs';

const exec = promisify(execFile);
const usage = message => { throw new UsageError(message); };
const TERMINAL = new Set(['result-accepted', 'failed', 'expired', 'cancelled']);

async function git(cwd, args) {
  try { return (await exec('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}})).stdout; }
  catch (error) { error.git = true; throw error; }
}
async function repository(cwd) {
  let top;
  try { top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { usage('faravan run works inside a git repository. Change into one, or use faravan job submit --source DIR.'); }
  try { await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); }
  catch { usage('This repository has no commits yet. Commit your work first.'); }
  return top;
}
export { changedFiles } from '../git-source-status.mjs';
// Working tree as a tar (tracked + untracked, ignoring .gitignore'd files; deleted files omitted).
export async function workingTreeSource(top) {
  const tracked = new Set((await git(top, ['ls-files', '-z', '--cached'])).split('\0').filter(Boolean));
  const listed = (await git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  const present = [], root = await realpath(top);
  for (const path of new Set(listed)) {
    try {
      const full=join(root,path);
      await lstat(full);
      // tar does not follow a leaf symlink, but explicit paths can traverse a symlinked
      // parent. In particular, an ignored replacement directory may be absent from ls-files.
      if(await realpath(dirname(full))!==dirname(full))
        throw new ArchiveError('link_rejected','Source paths through symbolic links are not sent.');
      present.push(path);
    } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
  }
  const buffer = await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-cf', '-', '--no-xattrs', '--null', '--no-recursion', '-C', top, '-T', '-'], {stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = []; let err = '';
    child.stdout.on('data', c => chunks.push(c)); child.stderr.on('data', c => err += c);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('tar failed: ' + err.trim())));
    child.stdin.end(present.length ? present.join('\0') + '\0' : '');
  });
  const filtered = filterSourceArchive(buffer, {tracked:path => tracked.has(path)});
  return {sourceTar:filtered.buffer, sourceOmissions:filtered.omitted};
}
export async function workingTreeTar(top) { return (await workingTreeSource(top)).sourceTar; }
async function chooseCircle(d, name) {
  if(name) {const circle=await d.selectCircle(name);return {circle,input:{circle:circle.id,expected_circle_id:circle.id}};}
  return resolveJobRecipient(name ? {circle:name} : {}, await jobCircles(d));
}
const viewLabel = statusLabel;
const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, {once: true});
});

export async function runJob(argv, options = {}) {
  if(argv.includes('--source')||argv.includes('--prompt-file'))return runSourceJob(argv,options);
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  const json = argv.includes('--json');
  try {
    const {flags, position} = parse(argv, ['circle', 'harness', 'model', 'egress', 'verify-cmd', 'attach', 'timeout'], ['detach', 'follow', 'include-uncommitted','send-anyway','freeze-audience','yes']);
    const timeout = flags.timeout === undefined ? null : Number(flags.timeout);
    if (timeout !== null && !(timeout >= 0 && Number.isFinite(timeout))) usage('Timeout must be a number of seconds.');
    const cwd = options.cwd ?? process.cwd();
    const d = options.device ?? await openDevice(options);
    const ops = options.operations ?? createJobOperations({...options, device: d});
    const say = text => { if (!json) stdout.write(text + '\n'); };
    const event = value => { if (json && flags.follow) stdout.write(JSON.stringify(value) + '\n'); };

    let digest, circleName, uncommitted, sourceOmissions, sourceManifest, warnings;
    if (flags.attach !== undefined) {
      if (position.length) usage('Use either a prompt or --attach, not both.');
      const found = await ops.resolve({digest: flags.attach, circle: flags.circle});
      digest = found.digest; circleName = found.circle;
    } else {
      if (!position.length) usage('Describe what you want the agent to do: faravan run "<prompt>". Run faravan run --help.');
      if (flags.follow && !json) usage('--follow is for --json. Text output already streams.');
      const prompt = position.join(' ');
      const top = await repository(cwd), changed = await changedFiles(top);
      let input;
      if (changed.length && !flags['include-uncommitted']) {
        const shown = changed.slice(0, 10).map(f => '  ' + f.code + ' ' + f.path);
        usage('You have uncommitted changes, and faravan run sends committed HEAD only:\n' + shown.join('\n') +
          (changed.length > 10 ? '\n  ... and ' + (changed.length - 10) + ' more' : '') +
          '\nCommit them, or pass --include-uncommitted to send the working tree.');
      }
      const recipient = await chooseCircle(d, flags.circle), circle=recipient.circle;
      await confirmJobSend(opById('jobs.submit').confirm({repo:{path:top,includeUncommitted:changed.length>0},circle:circle.name??circle.id}),flags.yes,options);
      if (changed.length) {
        input = {...await workingTreeSource(top), sourceLabel: basename(top) + ' (folder, with uncommitted changes)'}; uncommitted = changed.filter(f => !input.sourceOmissions.some(o => o.path===f.path)).map(f => f.path);
        if (!json && uncommitted.length) stderr.write('Including ' + uncommitted.length + ' uncommitted file' + (uncommitted.length === 1 ? '' : 's') + ':\n' +
          changed.filter(f=>uncommitted.includes(f.path)).map(f => '  ' + f.code + ' ' + JSON.stringify(f.path).slice(1,-1)).join('\n') + '\n');
      } else input = {source: top};
      if(recipient.input.expected_default_circle) resolveJobRecipient(recipient.input,await jobCircles(d));
      const submitted = await ops.submit({...input, prompt, harness: flags.harness, model: flags.model, egress: flags.egress,
        expected_circle_id:circle.id,
        ...(recipient.input.expected_default_circle ? {expected_default_circle:recipient.input.expected_default_circle} : {}),
        ...(flags['send-anyway']?{send_anyway:true}:{}),
        ...(flags['freeze-audience']?{freeze_audience:true}:{}),
        ...(flags['verify-cmd']===undefined?{}:{verify:{cmd:flags['verify-cmd']}}),circle: circle.id}, {signal: options.signal});
      digest = submitted.jobDigest ?? submitted.job_digest; circleName = circle.id;
      sourceOmissions=submitted.sourceOmissions; sourceManifest=submitted.sourceManifest; warnings=submitted.warnings;
      say('Job ' + shortId(digest) + ' submitted to ' + circle.name + ' (' + basename(top) + ')');
      for (const warning of submitted.warnings ?? []) say(warning);
      if(sourceOmissions?.length===0) say('0 files not sent by filename rules');
      if(sourceManifest) say('Sending '+sourceManifest.file_count+' files · '+sourceManifest.packed_bytes+' bytes packed · filename rules only; contents not scanned.');
      event({event: 'submitted', job_digest: digest, circle: circle.id, ...(sourceManifest ? {sourceManifest} : {}), ...(sourceOmissions ? {sourceOmissions,warnings:warnings??[]} : {}), ...(uncommitted ? {uncommitted_files: uncommitted} : {})});
      if (flags.detach) {
        say('Check on it: faravan job status ' + shortId(digest));
        say('Follow it:   faravan run --attach ' + shortId(digest));
        say('Stop it:     faravan stop ' + shortId(digest));
        if (json && !flags.follow) stdout.write(JSON.stringify({job_digest: digest, circle: circle.id, detached: true, ...(sourceManifest ? {sourceManifest} : {}), ...(sourceOmissions ? {sourceOmissions,warnings:warnings??[]} : {}), ...(uncommitted ? {uncommitted_files: uncommitted} : {})}) + '\n');
        return 0;
      }
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal) options.signal.addEventListener('abort', abort, {once: true});
    else process.once('SIGINT', abort);
    const deadline = timeout === null ? Infinity : Date.now() + timeout * 1000;
    try {
      let last = null, failures = 0, view;
      for (;;) {
        try { view = await ops.get({digest, circle: circleName}, {signal: controller.signal}); failures = 0; }
        catch (error) {
          if (controller.signal.aborted) break;
          if (error?.retryable && ++failures < 4) { await sleep(options.pollMs ?? 1000, controller.signal); continue; }
          throw error;
        }
        const label = viewLabel(view);
        const line = statusMessage(view);
        if (line !== last) {
          last = line; say(line);
          event({event: 'status', job_digest: digest, state: view.state, status: label});
        }
        if (TERMINAL.has(view.state) && !(view.state === 'cancelled' && label === 'Stop requested')) break;
        if (Date.now() >= deadline || controller.signal.aborted) break;
        await sleep(options.pollMs ?? 1000, controller.signal);
      }
      const done = view && TERMINAL.has(view.state) && !(view.state === 'cancelled' && viewLabel(view) === 'Stop requested');
      const next = 'faravan apply ' + shortId(digest);
      if (!done) {
        say('Still going. It keeps running without you.');
        say('Follow it: faravan run --attach ' + shortId(digest));
        say('Stop it: faravan stop ' + shortId(digest));
        if (json) stdout.write(JSON.stringify({event: 'waiting', job_digest: digest, state: view?.state ?? null, status: view ? viewLabel(view) : null}) + '\n');
        return controller.signal.aborted ? 130 : 5;
      }
      if (view.state === 'result-accepted') {
        say('Use these changes: ' + next);
        say('Review and test it before you use it. Nothing is applied for you.');
      } else say('No result. See details: faravan job status ' + shortId(digest));
      event({event: 'finished', job_digest: digest, state: view.state, status: viewLabel(view), result_digest: view.result_digest ?? null});
      if (json && !flags.follow) stdout.write(JSON.stringify({job_digest: digest, circle: circleName, state: view.state, status: viewLabel(view),
        result_digest: view.result_digest ?? null, ...(view.state === 'result-accepted' ? {next} : {}), ...(sourceManifest ? {sourceManifest} : {}), ...(sourceOmissions ? {sourceOmissions,warnings:warnings??[]} : {}), ...(uncommitted ? {uncommitted_files: uncommitted} : {})}) + '\n');
      return view.state === 'result-accepted' ? 0 : 1;
    } finally {
      options.signal?.removeEventListener('abort', abort); process.removeListener('SIGINT', abort);
    }
  } catch (error) {
    const problem = problemForError(error);
    if (json) stdout.write(JSON.stringify(problem) + '\n'); else stderr.write('faravan: ' + problemText(problem) + '\n');
    return exitCodeForError(error);
  }
}

// The app decides consent for each operation. Only its explicit refusal can
// trigger a terminal question; the wrapper never reads saved permissions.
async function runSourceJob(argv,options){
  const stdout=options.stdout??process.stdout,stderr=options.stderr??process.stderr;
  const client=options.opsClient??createOpsClient({home:options.home??configHome(),surface:'cli'});
  const now=options.now??Date.now,started=now();
  let digest,confirmed=false;
  const output=value=>stdout.write(JSON.stringify(value)+'\n');
  try {
    const {flags,position}=parse(argv,['source','prompt-file','circle','model','effort','harness','branch','timeout'],['include-uncommitted','yes']);
    if(position.length||!flags.source||!flags['prompt-file'])usage('Use faravan run --source DIR --prompt-file FILE.');
    const seconds=flags.timeout===undefined?1200:Number(flags.timeout);
    if(!Number.isFinite(seconds)||seconds<0)usage('Timeout must be a non-negative number of seconds.');
    const deadline=started+seconds*1000;
    confirmed=flags.yes===true;
    const call=async(id,input)=>{
      try {return await client.call(id,input,{confirmed,signal:options.signal});}
      catch(error){
        if(error.code!=='confirmation_required')throw error;
        try {await confirmJobSend(error.effect+' After it finishes, save the result as a new branch.',confirmed,{...options,stderr});}
        catch(refusal){if(refusal.code==='confirmation_required')throw error;throw refusal;}
        confirmed=true;
        return client.call(id,{...input,...error.confirmation_input},{confirmed:true,signal:options.signal});
      }
    };
    const source=await repository(resolve(options.cwd??process.cwd(),flags.source));
    const sent=await call('jobs.submit',{repo:{path:source,includeUncommitted:flags['include-uncommitted']===true},
      prompt:await readFile(resolve(options.cwd??process.cwd(),flags['prompt-file']),'utf8'),
      ...Object.fromEntries(['circle','model','harness'].filter(k=>flags[k]!==undefined).map(k=>[k,flags[k]])),
      ...(flags.effort?{budget_v1:{effort:flags.effort}}:{})});
    digest=sent.jobDigest;
    const waitBegan=now();
    let secondsWaited;
    let job;
    for(;;){
      const remaining=(deadline-now())/1000;
      if(remaining<=0){output({job_id:digest,state:'timeout',reason:'The wait ended. The job may still be running; follow this job id.',seconds_waited:(now()-waitBegan)/1000});return 5;}
      const waited=await client.call('jobs.wait',{digest,...(flags.circle?{circle:flags.circle}:{}),timeout_seconds:Math.min(300,Math.max(1,Math.ceil(remaining)))},{signal:options.signal});
      job=waited.job;
      secondsWaited=(now()-waitBegan)/1000;
      const held=job.approval?.required===true||job.statusContract?.lifecycle==='approval_pending'||job.state==='held'||job.status==='Needs approval'||job.status==='Approval needed';
      const state=held?'held':job.state;
      if(held||['failed','expired','cancelled'].includes(state)){
        output({job_id:digest,state,reason:job.statusContract?.explanation??job.reason??job.waiting_reason??job.status??state,seconds_waited:secondsWaited});
        return {held:9,expired:10,failed:11,cancelled:12}[state];
      }
      if(job.state==='result-accepted')break;
      // A bounded wait ending is pending, never permission to send again.
    }
    const circle=job.circle?.id??job.borrowerCircle??flags.circle;
    const target={digest,circle,repo:source,branch:flags.branch??'faravan/'+digest.slice(7,19)};
    const changes=await client.call('jobs.changes',{digest,circle},{signal:options.signal});
    const preview=await client.call('jobs.apply_preview',target,{signal:options.signal});
    const result=await client.call('jobs.result',{digest,circle},{signal:options.signal});
    const transcript=await client.call('jobs.transcript',{digest,circle},{signal:options.signal});
    const transcriptPath=join(result.path,'transcript.txt');
    await writeFile(transcriptPath,transcript.text??'',{mode:0o600});
    const applied=await call('jobs.apply',{...target,expect:{preview_token:preview.preview_token}});
    const receipt=changes.receipt??{};
    output({job_id:digest,state:job.state,lender_device:changes.resultAuthor?.name??job.lenderName??job.current_attempt?.device_name??null,
      model:receipt.model??receipt.budget_v1?.model??job.model??null,
      effort:receipt.budget_v1?.effort??receipt.auto_run_v1?.effort??receipt.selection?.effortId??job.effort??null,
      branch:applied.branch,commit:applied.commit,changed_files:(changes.files??[]).map(file=>typeof file==='string'?file:file.path),transcript_path:transcriptPath,seconds_waited:secondsWaited});
    return 0;
  }catch(error){
    output({... (error instanceof UsageError?problemForError(error):problemOf(error)),...(digest||error.jobDigest?{job_id:digest??error.jobDigest}:{})});
    return exitCodeFor(error);
  }
}
