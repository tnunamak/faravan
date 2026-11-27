import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildImportedWeeklyScores, readLocalAgentSessionLogs, readLocalAgentSessionLogsInWorker} from '../lib/v1/lending-history-import.mjs';

const start = Date.parse('2026-10-01T00:00:00Z');
const end = start + 7 * 24 * 60 * 60 * 1000;
const tokens = {fresh_input:1_000_000,cache_read:0,cache_write_5m:0,cache_write_1h:0,output:0,reasoning:0};
const usage = [{account:'claude',provider:'claude',at:start+1000,model:'claude-haiku-4-5-20251001',tokens}];
const meterPeriods = [{account:'claude',resource:'claude:seven_day',account_week_id:end,week_start:start,start_at:start,end_at:end,meter_points:0.000001}];
const kappaForUsage = () => ({upper_micro:1_000_000,provenance:{method:'test',boundReport:'fixture',acceptedBy:'test'}});

for (const kind of ['droppedItems', 'untrusted']) test(`backdated ${kind} conservatively taints its account`, () => {
  const result = buildImportedWeeklyScores({usage,meterPeriods,kappaForUsage,minimumCoverage:0.000001,
    [kind]:[{provider:'claude',account:'claude',mtimeMs:Date.parse('2020-01-01T00:00:00Z')}]});
  assert.equal(result.weeklyScores[0].incomplete,true);
  assert.equal(result.weeklyScores[0].censored,true);
});

for (const shape of ['oversized', 'malformed']) test(`backdated ${shape} file censors a covered week`, async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-backdated-'));
  try {
    const {truncateSync,utimesSync} = await import('node:fs');
    const {importOwnerLendingHistory} = await import('../lib/v1/lending-history-import.mjs');
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const good = JSON.stringify({type:'assistant',timestamp:new Date(start+1000).toISOString(),message:{id:'good',
      model:'claude-haiku-4-5-20251001',usage:{input_tokens:1_000_000,output_tokens:0}}});
    writeFileSync(join(dir,'good.jsonl'),good+'\n');
    const bad = join(dir,'bad.jsonl'); writeFileSync(bad,shape === 'malformed' ? 'not-json\n' : '');
    if (shape === 'oversized') truncateSync(bad,65*1024*1024);
    const old = new Date('2020-01-01T00:00:00Z'); utimesSync(bad,old,old);
    let written = [];
    const result = await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage,minimumCoverage:0.000001,
      historyAdapter:()=>({meterPeriods,existingScores:[],writeImportedScores(rows){written=rows;}})});
    assert.equal(written.length,1);
    assert.equal(written[0].censored,true);
    assert.equal(written[0].incomplete,true);
    assert.ok(shape === 'oversized' ? result.skipped_files > 0 : result.malformed_lines > 0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('both readers deduplicate hardlinks', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-hardlinks-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const first = join(dir,'a.jsonl'); writeFileSync(first,'{}\n'); linkSync(first,join(dir,'b.jsonl'));
    for (const [name,read] of [['sync', () => [...readLocalAgentSessionLogs(home)]],
      ['worker', async () => (await readLocalAgentSessionLogsInWorker(home)).logs]]) {
      assert.equal((await read()).length,1,name);
    }
  } finally {rmSync(home,{recursive:true,force:true});}
});


test('worker exposes per-file progress to the caller', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-progress-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file = join(dir,'a.jsonl'); writeFileSync(file,'{}\n');
    const progress = [];
    await readLocalAgentSessionLogsInWorker(home,{onProgress:event => progress.push(event)});
    assert.ok(progress.some(event => event.file === file), 'file start reaches caller');
    assert.ok(progress.some(event => event.filesDone >= 1), 'file completion reaches caller');
  } finally {rmSync(home,{recursive:true,force:true});}
});


test('deep irrelevant content does not crash usage parsing', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-deep-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const prefix = '{"type":"assistant","timestamp":"2026-10-02T00:00:00Z","message":{"id":"one","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":1,"output_tokens":0},"content":';
    writeFileSync(join(dir,'a.jsonl'),prefix+'['.repeat(100000)+'0'+']'.repeat(100000)+'}}\n');
    const result = await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.errorCode,undefined);
    assert.equal(result.logs[0].parsed.usage.length,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker error reports the in-flight file and message', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-error-'));
  try {
    const result = await readLocalAgentSessionLogsInWorker(home,{workerUrl:new URL('./fixtures/history-worker-error.cjs',import.meta.url)});
    assert.equal(result.errorCode,'history_worker_error');
    assert.equal(result.errorMessage,'synthetic read failure');
    assert.deepEqual(result.skippedFilePaths,['/synthetic/broken.jsonl']);
    assert.equal(result.skippedFiles,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('discovery limits the number of history files and reports incomplete', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-many-files-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    for (let i=0;i<1025;i++) writeFileSync(join(dir,`${i}.jsonl`),'');
    const result = await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.incomplete,true);
    assert.ok(result.logs.length <= 1024);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('oversized line is discarded within a small worker heap', async () => {
  const {Worker} = await import('node:worker_threads');
  const home = mkdtempSync(join(tmpdir(),'round4-line-memory-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const valid = JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:'kept',model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}});
    writeFileSync(join(dir,'a.jsonl'),'x'.repeat(32*1024*1024)+'\n'+valid+'\n');
    const worker = new Worker(new URL('../lib/v1/lending-history-worker.cjs',import.meta.url),{
      workerData:{homeDir:home,cached:{},importerUrl:new URL('../lib/v1/lending-history-import.mjs',import.meta.url).href},
      resourceLimits:{maxOldGenerationSizeMb:16},
    });
    const result = await new Promise((resolve,reject) => {
      let log;
      worker.on('message',message=>{
        if (message.type==='progress' && message.file) worker.postMessage({type:'started'});
        if (message.type==='file') {log=message.log; worker.postMessage({type:'continue',value:true});}
        if (message.type==='error') reject(new Error(message.message));
        if (message.type==='done') resolve({log,stats:message.stats});
      });
      worker.on('error',reject);
      worker.on('exit',code=>{if(code!==0)reject(new Error(`worker exited ${code}`));});
    });
    await worker.terminate();
    assert.equal(result.stats.skippedLines,1);
    assert.equal(result.log.parsed.usage.length,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker exiting successfully without done is incomplete', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-exit-'));
  try {
    const result = await readLocalAgentSessionLogsInWorker(home,{workerUrl:new URL('./fixtures/history-worker-exit.cjs',import.meta.url)});
    assert.equal(result.errorCode,'history_worker_exited_early');
    assert.equal(result.incomplete,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker delivers a large file in bounded usage chunks', async () => {
  const {Worker} = await import('node:worker_threads');
  const home = mkdtempSync(join(tmpdir(),'round4-chunks-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const rows = Array.from({length:2500},(_,i)=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}}));
    writeFileSync(join(dir,'a.jsonl'),rows.join('\n'));
    const worker = new Worker(new URL('../lib/v1/lending-history-worker.cjs',import.meta.url),{workerData:{homeDir:home,cached:{},importerUrl:new URL('../lib/v1/lending-history-import.mjs',import.meta.url).href}});
    const sizes = [], provisional = [];
    await new Promise((resolve,reject)=>{
      worker.on('message',message=>{
        if(message.type==='progress' && message.file) worker.postMessage({type:'started'});
        if(message.type==='file' || message.type==='fileChunk') {
          if (message.provisional) provisional.push(message.log.parsed.usage.length);
          else sizes.push((message.log?.parsed?.usage ?? message.usage).length);
          worker.postMessage({type:'continue',value:true});
        }
        if(message.type==='error') reject(new Error(message.message));
        if(message.type==='done') resolve();
      });
      worker.on('error',reject);
    });
    await worker.terminate();
    assert.ok(provisional.length > 0, "rows arrive while parsing");
    assert.ok(provisional.every(size=>size<=1000));
    assert.ok(sizes.length > 1);
    assert.ok(sizes.every(size=>size<=1000));
    assert.equal(sizes.reduce((a,b)=>a+b,0),2500);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker caps total usage rows across files', async () => {
  const home = mkdtempSync(join(tmpdir(),'round4-total-rows-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const rows = Array.from({length:25000},(_,i)=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}})).join('\n');
    for (let i=0;i<9;i++) writeFileSync(join(dir,`${i}.jsonl`),rows);
    const result = await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs.reduce((sum,log)=>sum+log.parsed.usage.length,0),200000);
    assert.equal(result.skippedFiles,1);
    assert.equal(result.incomplete,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synchronous reader refuses an oversized file before reading it', async () => {
  const {truncateSync} = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(),'round4-sync-size-'));
  try {
    const dir = join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl'); writeFileSync(file,''); truncateSync(file,65*1024*1024);
    assert.throws(()=>[...readLocalAgentSessionLogs(home)],/history.*size/i);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker refuses a symlinked history root', async () => {
  const {symlinkSync} = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(),'round4-root-symlink-'));
  try {
    const outside = join(home,'outside'); mkdirSync(outside,{recursive:true});
    writeFileSync(join(outside,'a.jsonl'),'{}\n');
    mkdirSync(join(home,'.claude'),{recursive:true});
    symlinkSync(outside,join(home,'.claude','projects'));
    const result = await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs.length,0);
    assert.equal(result.incomplete,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker detects a file replaced with a symlink before reading', async () => {
  const {renameSync,symlinkSync} = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(),'round4-swap-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl'), outside=join(home,'outside'); writeFileSync(file,'{}\n'); writeFileSync(outside,'not-json\n');
    let swapped=false;
    const result=await readLocalAgentSessionLogsInWorker(home,{onProgress(event){
      if(event.file===file&&!swapped){swapped=true;renameSync(file,join(dir,'saved'));symlinkSync(outside,file);}
    }});
    assert.equal(swapped,true);
    assert.equal(result.incomplete,true);
    assert.equal(result.logs.length,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('final chunks replace provisional rows after a conflicting duplicate', async () => {
  const home=mkdtempSync(join(tmpdir(),'round4-chunk-conflict-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const row=(id,input)=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id,model:'claude-haiku-4-5-20251001',usage:{input_tokens:input,output_tokens:1}}});
    const rows=Array.from({length:1000},(_,i)=>row(String(i),1)); rows.push(row('0',2));
    writeFileSync(join(dir,'a.jsonl'),rows.join('\n'));
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs.length,1);
    assert.equal(result.logs[0].parsed.usage.length,999);
    assert.equal(result.logs[0].parsed.malformedLines,1);
    assert.ok(result.logs[0].parsed.usage.every(row=>row.message_id!=='0'));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a stalled worker retains provisional rows and marks the file incomplete', async () => {
  const home=mkdtempSync(join(tmpdir(),'round4-partial-'));
  try {
    // Use the production timeout so the fixture can publish partial rows under CPU contention.
    const result=await readLocalAgentSessionLogsInWorker(home,{workerUrl:new URL('./fixtures/history-worker-partial.cjs',import.meta.url)});
    assert.equal(result.errorCode,'history_worker_timeout');
    assert.equal(result.incomplete,true);
    assert.deepEqual(result.skippedFilePaths,['/synthetic/slow.jsonl']);
    assert.equal(result.logs[0].parsed.usage[0].message_id,'partial');
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synchronous discovery refuses unbounded file lists', () => {
  const home=mkdtempSync(join(tmpdir(),'round4-sync-files-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    for(let i=0;i<1025;i++) writeFileSync(join(dir,`${i}.jsonl`),'');
    assert.throws(()=>[...readLocalAgentSessionLogs(home)],/history.*limit/i);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker rejects a file changed while parsing', async () => {
  const {appendFileSync}=await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'round4-mutation-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl');
    const rows=Array.from({length:2500},(_,i)=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}}));
    writeFileSync(file,rows.join('\n'));
    let changed=false;
    const result=await readLocalAgentSessionLogsInWorker(home,{onProgress(event){
      if(event.rowsReceived>=1000&&!changed){changed=true;appendFileSync(file,'\n{}\n');}
    }});
    assert.equal(changed,true);
    assert.equal(result.incomplete,true);
    assert.ok(result.skippedFilePaths.includes(file));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synchronous reader rejects an oversized line', () => {
  const home=mkdtempSync(join(tmpdir(),'round4-sync-line-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'a.jsonl'),'x'.repeat(1024*1024+1));
    assert.throws(()=>[...readLocalAgentSessionLogs(home)],/history.*line/i);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synchronous reader bounds records per file', () => {
  const home=mkdtempSync(join(tmpdir(),'round4-sync-records-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'a.jsonl'),'{}\n'.repeat(25001));
    for (const incremental of [false,true])
      assert.throws(()=>[...readLocalAgentSessionLogs(home,{incremental})],/history.*record/i);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker rejects usage identifiers larger than the history store accepts', async () => {
  const home=mkdtempSync(join(tmpdir(),'round4-large-id-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const row={type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:'x'.repeat(513),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}};
    writeFileSync(join(dir,'a.jsonl'),JSON.stringify(row));
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs[0].parsed.usage.length,0);
    assert.equal(result.logs[0].parsed.malformedLines,1);
    assert.ok(result.droppedItems.length);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synchronous cache cannot bypass worker row identifier bounds', async () => {
  const home=mkdtempSync(join(tmpdir(),'round4-cached-id-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const row={type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:'x'.repeat(513),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}};
    writeFileSync(join(dir,'a.jsonl'),JSON.stringify(row));
    [...readLocalAgentSessionLogs(home,{incremental:true})];
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs[0].parsed.usage.length,0);
    assert.ok(result.droppedItems.length);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('interrupted account history write keeps the previous file and permits retry', async () => {
  const {fork}=await import('node:child_process');
  const {readFileSync}=await import('node:fs');
  const {createLocalLendingHistoryAdapter}=await import('../lib/v1/lending-history-import.mjs');
  const home=mkdtempSync(join(tmpdir(),'round4-crash-'));
  try {
    const adapter=()=>createLocalLendingHistoryAdapter({homeDir:home,now:()=>end+1000});
    const row=score=>({resource:'claude:seven_day',account_week_id:end,week_start:start,score,censored:false,source:'import',coverage_ratio:1});
    adapter().writeImportedScores([row(1)],[],[]);
    const file=join(home,'v1','lending-history-claude.json'), before=readFileSync(file,'utf8');
    const child=fork(new URL('./fixtures/history-crash-before-rename.cjs',import.meta.url),[],{env:{...process.env,HOME:home},stdio:['ignore','ignore','ignore','ipc']});
    await new Promise((resolve,reject)=>{child.once('message',message=>message==='ready'?resolve():reject(new Error(JSON.stringify(message))));child.once('error',reject);child.once('exit',code=>reject(new Error(`early exit ${code}`)));});
    const exited=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGKILL'); await exited;
    assert.equal(readFileSync(file,'utf8'),before);
    adapter().writeImportedScores([row(2)],[],[]);
    assert.notEqual(readFileSync(file,'utf8'),before);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('cached history is not reused after a file changes at start', async () => {
  const {appendFileSync}=await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'round4-cached-mutation-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl'); writeFileSync(file,'{}\n');
    await readLocalAgentSessionLogsInWorker(home);
    let changed=false;
    const result=await readLocalAgentSessionLogsInWorker(home,{onProgress(event){
      if(event.file===file&&!changed){changed=true;appendFileSync(file,'not-json\n');}
    }});
    assert.equal(changed,true);
    assert.equal(result.incomplete,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

for (const shape of ['symlink','fifo']) test(`special ${shape} history entry is not imported`, async () => {
  const {symlinkSync}=await import('node:fs');
  const {spawnSync}=await import('node:child_process');
  const home=mkdtempSync(join(tmpdir(),'round4-special-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl');
    if(shape==='symlink') {const target=join(home,'outside');writeFileSync(target,'not-json\n');symlinkSync(target,file);}
    else {const made=spawnSync('mkfifo',[file]);assert.equal(made.status,0);}
    const result=await readLocalAgentSessionLogsInWorker(home,{timeoutMs:2000});
    assert.equal(result.logs.length,0);
    assert.equal(result.incomplete,true);
    assert.throws(()=>[...readLocalAgentSessionLogs(home)],/history/i);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('unreadable history preserves earlier files and identifies the failure', async () => {
  const {chmodSync,utimesSync}=await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'round4-unreadable-'));
  try {
    const dir=join(home,'.claude','projects','fixture'); mkdirSync(dir,{recursive:true});
    const good=join(dir,'good.jsonl'),bad=join(dir,'bad.jsonl');
    writeFileSync(good,'{}\n');writeFileSync(bad,'{}\n');
    const old=new Date('2020-01-01T00:00:00Z');utimesSync(bad,old,old);chmodSync(bad,0);
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.incomplete,true);
    assert.equal(result.logs.length,1);
    assert.ok(result.skippedFilePaths.includes(bad));
    assert.ok(result.errorMessage);
  } finally {chmodSync(join(home,'.claude','projects','fixture','bad.jsonl'),0o600);rmSync(home,{recursive:true,force:true});}
});

test('five-hour peak includes a row exactly five hours before another', () => {
  const fiveHours=5*60*60*1000, finish=end;
  const rows=[{...usage[0],at:start+1000},{...usage[0],at:start+1000+fiveHours}];
  const weekly={...meterPeriods[0],resource:'claude:five_hour',meter_points:1,end_at:finish,account_week_id:finish};
  const result=buildImportedWeeklyScores({usage:rows,meterPeriods:[weekly],kappaForUsage,minimumCoverage:0.5});
  const single=buildImportedWeeklyScores({usage:[rows[0]],meterPeriods:[weekly],kappaForUsage,minimumCoverage:0.5});
  assert.ok(Number.isFinite(single.weeklyScores[0].score));
  assert.ok(Number.isFinite(result.weeklyScores[0].score));
  assert.equal(single.weeklyScores[0].censored,false);
  assert.equal(result.weeklyScores[0].censored,false);
  assert.equal(result.weeklyScores[0].score,2*single.weeklyScores[0].score);
});

test('worker reparses when a cached entry is evicted during import', async () => {
  const home=mkdtempSync(join(tmpdir(),'round4-cache-eviction-'));
  const other=mkdtempSync(join(tmpdir(),'round4-cache-fill-'));
  try {
    const dir=join(home,'.claude','projects','fixture');mkdirSync(dir,{recursive:true});
    const file=join(dir,'a.jsonl');
    const makeRow=i=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}});
    writeFileSync(file,makeRow('original'));
    await readLocalAgentSessionLogsInWorker(home);
    const fill=join(other,'.claude','projects','fixture');mkdirSync(fill,{recursive:true});
    const rows=Array.from({length:25000},(_,i)=>makeRow(i)).join('\n');
    for(let i=0;i<3;i++)writeFileSync(join(fill,`${i}.jsonl`),rows);
    let evicted=false;
    const result=await readLocalAgentSessionLogsInWorker(home,{onProgress(event){
      if(event.file===file&&!evicted){evicted=true;[...readLocalAgentSessionLogs(other,{incremental:true})];}
    }});
    assert.equal(evicted,true);
    assert.equal(result.errorCode,undefined);
    assert.equal(result.logs[0].parsed.usage[0].message_id,'original');
  } finally {rmSync(home,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});

test('cached file respects the remaining import row budget', async () => {
  const {utimesSync}=await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'round4-cached-budget-'));
  try {
    const dir=join(home,'.claude','projects','fixture');mkdirSync(dir,{recursive:true});
    const row=i=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}});
    const target=join(dir,'old.jsonl');writeFileSync(target,Array.from({length:100},(_,i)=>row(i)).join('\n'));
    const old=new Date('2020-01-01T00:00:00Z');utimesSync(target,old,old);
    await readLocalAgentSessionLogsInWorker(home);
    const rows=Array.from({length:24999},(_,i)=>row(i)).join('\n');
    for(let i=0;i<8;i++)writeFileSync(join(dir,`${i}.jsonl`),rows);
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs.reduce((sum,log)=>sum+log.parsed.usage.length,0),200000);
    assert.equal(result.incomplete,true);
    assert.equal(result.skippedRows,92);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('Codex cumulative snapshots retain IDs equal to internal prior markers', async () => {
  const {parseCodexRolloutLog}=await import('../lib/v1/lending-history-import.mjs');
  const home=mkdtempSync(join(tmpdir(),'round2-codex-id-'));
  try {
    const dir=join(home,'.codex','sessions');mkdirSync(dir,{recursive:true});
    const row=(id,input,second)=>JSON.stringify({timestamp:`2026-10-02T00:00:0${second}Z`,message_id:id,payload:{type:'token_count',model:'gpt-6-luna',info:{total_token_usage:{input_tokens:input,output_tokens:0}}}});
    const text=[row('ordinary',1000000,0),row('__worker_prior__',1100000,1),row('__worker_prior__0',1200000,2)].join('\n');
    writeFileSync(join(dir,'rollout-fixture.jsonl'),text);
    const canonical=parseCodexRolloutLog(text), result=await readLocalAgentSessionLogsInWorker(home);
    assert.deepEqual(result.logs[0].parsed.usage,canonical.usage);
    assert.equal(result.logs[0].parsed.malformedLines,canonical.malformedLines);
    assert.equal(result.incomplete,false);
    assert.deepEqual(result.droppedItems,[]);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('deleting imported history resets cache row accounting', async () => {
  const {createLocalLendingHistoryAdapter}=await import('../lib/v1/lending-history-import.mjs');
  const home=mkdtempSync(join(tmpdir(),'round2-cache-reset-'));
  const other=mkdtempSync(join(tmpdir(),'round2-cache-reuse-'));
  try {
    const dir=join(home,'.claude','projects','fixture');mkdirSync(dir,{recursive:true});
    const row=i=>JSON.stringify({type:'assistant',timestamp:'2026-10-02T00:00:00Z',message:{id:String(i),model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}});
    const rows=Array.from({length:25000},(_,i)=>row(i)).join('\n');
    writeFileSync(join(dir,'a.jsonl'),rows);writeFileSync(join(dir,'b.jsonl'),rows);
    [...readLocalAgentSessionLogs(home,{incremental:true})];
    createLocalLendingHistoryAdapter({homeDir:home}).deleteImportedHistory();
    const otherDir=join(other,'.claude','projects','fixture');mkdirSync(otherDir,{recursive:true});
    writeFileSync(join(otherDir,'a.jsonl'),row('one'));
    assert.notEqual([...readLocalAgentSessionLogs(other,{incremental:true})][0].contents,'');
    assert.equal([...readLocalAgentSessionLogs(other,{incremental:true})][0].contents,'');
  } finally {rmSync(home,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});

for (const [name,totals] of [
  ['invalid cached delta',[[100,50],[110,70],[130,75]]],
  ['decreasing totals',[[100,20],[50,10],[75,15]]],
]) test(`Codex worker matches canonical state after ${name}`, async () => {
  const {parseCodexRolloutLog}=await import('../lib/v1/lending-history-import.mjs');
  const home=mkdtempSync(join(tmpdir(),'round2-codex-totals-'));
  try {
    const dir=join(home,'.codex','sessions');mkdirSync(dir,{recursive:true});
    const text=totals.map(([input,cached],i)=>JSON.stringify({timestamp:`2026-10-02T00:00:0${i}Z`,message_id:String(i),payload:{type:'token_count',model:'gpt-6-luna',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:0}}}})).join('\n');
    writeFileSync(join(dir,'rollout-fixture.jsonl'),text);
    const canonical=parseCodexRolloutLog(text),result=await readLocalAgentSessionLogsInWorker(home);
    assert.deepEqual(result.logs[0].parsed.usage,canonical.usage);
    assert.equal(result.logs[0].parsed.malformedLines,canonical.malformedLines);
    assert.equal(canonical.malformedLines,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

for (const cached of [false,true]) test(`malformed-only import is incomplete${cached?' with cached data':''}`, async () => {
  const {importOwnerLendingHistory}=await import('../lib/v1/lending-history-import.mjs');
  const home=mkdtempSync(join(tmpdir(),'round5-malformed-'));
  try {
    const dir=join(home,'.claude','projects','fixture');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'a.jsonl'),'not-json\n');
    if(cached) await readLocalAgentSessionLogsInWorker(home);
    let written=[];
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage,
      historyAdapter:()=>({meterPeriods,existingScores:[],writeImportedScores(rows){written=rows;}})});
    assert.equal(result.malformed_lines,1);
    assert.equal(result.incomplete,true);
    assert.equal(written[0].incomplete,true);
    assert.equal(written[0].censored,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});
