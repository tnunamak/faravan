import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayTranscript, createTranscriptPublisher } from '../lib/v1/live-transcript.mjs';

const line = value => JSON.stringify(value)+'\n';
const message = text => line({type:'assistant',message:{content:[{type:'text',text}]}});

test('relay projection retains activity while dropping account metadata, private paths, secrets and file contents', () => {
  const relay=createRelayTranscript({privateValues:['private-lender-token']});
  relay.append(line({type:'system',subtype:'init',email:'lender@example.com',cwd:'/home/lender/private'}));
  relay.append(message('I will inspect the parser.'));
  relay.append(line({type:'assistant',account:{email:'lender@example.com'},message:{content:[
    {type:'tool_use',id:'private-session-123',name:'Edit',input:{file_path:'/workspace/repo/parser.mjs',old_string:'private file contents',new_string:'also private'}},
    {type:'text',text:'Found /home/lender/private/cache and lender@example.com with private-lender-token'}]}}));
  const view=relay.snapshot();
  assert.match(view.text,/I will inspect the parser|parser.mjs/);
  assert.doesNotMatch(view.text,/lender@example|\/home\/lender|private-session|private-lender-token|private file contents|also private|account/);
  assert.match(view.text,/withheld/);
});

test('every input split redacts complete records and preserves tool progress/output correlation', () => {
  const raw=line({type:'assistant',message:{content:[{type:'tool_use',id:'secret-identity',name:'Bash',input:{command:'npm test'}}]}})+
    line({type:'tool_progress',parent_tool_use_id:'secret-identity',elapsed_time_seconds:45})+
    line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'secret-identity',content:'Tests passed',is_error:false}]}});
  for(let i=0;i<raw.length;i++) {
    const relay=createRelayTranscript();relay.append(raw.slice(0,i));relay.append(raw.slice(i));
    const events=relay.snapshot().text.trim().split('\n').map(JSON.parse);
    assert.equal(events[0].message.content[0].id,events[1].parent_tool_use_id);
    assert.equal(events[0].message.content[0].id,events[2].message.content[0].tool_use_id);
    assert.doesNotMatch(relay.snapshot().text,/secret-identity/);
  }
});

test('relay memory and snapshots are bounded even on an endless unfinished line and Unicode output', () => {
  const relay=createRelayTranscript();
  relay.append('x'.repeat(2*1024*1024));relay.append('\n');
  for(let i=0;i<120;i++)relay.append(message('Entry '+i+' '+ '🦆'.repeat(1000)));
  const view=relay.snapshot();
  assert.ok(Buffer.byteLength(view.text)<=64*1024);
  assert.equal(view.truncated,true);
  assert.doesNotMatch(view.text,/�/);
  for(const row of view.text.trim().split('\n'))assert.doesNotThrow(()=>JSON.parse(row));
});

test('publisher sends one bounded snapshot at a time, coalesces updates and swallows network failures', async () => {
  let at=0,scheduled,clearCount=0;const sent=[];
  const reporter=createTranscriptPublisher({send:async value=>{sent.push(value);if(sent.length===2)throw Error('offline');},now:()=>at,
    schedule:fn=>(scheduled=fn,1),unschedule:()=>{scheduled=null;clearCount++;}});
  reporter.append(message('First'));await reporter.settled();
  assert.equal(sent.length,1);assert.equal(sent[0].seq,1);
  for(let i=0;i<100;i++)reporter.append(message('Next '+i));
  await reporter.settled();assert.equal(sent.length,1);
  at=5000;scheduled();await reporter.settled();
  assert.equal(sent.length,2);assert.match(sent[1].text,/Next 99/);
  reporter.append(message('Last pending'));await reporter.close();assert.ok(clearCount>0);
  reporter.append(message('Too late'));await reporter.settled();assert.equal(sent.length,2);
});

test('a slow upload keeps only the latest snapshot instead of queueing transcript bodies', async () => {
  let release,at=0;const held=new Promise(resolve=>{release=resolve;}),sent=[];
  const reporter=createTranscriptPublisher({now:()=>at,send:async value=>{sent.push(value);if(sent.length===1)await held;}});
  reporter.append(message('First'));await Promise.resolve();
  for(let i=0;i<500;i++){at+=5000;reporter.append(message('Latest '+i));}
  assert.equal(sent.length,1);
  release();await reporter.settled();await reporter.settled();
  assert.equal(sent.length,2);assert.match(sent[1].text,/Latest 499/);
  assert.ok(Buffer.byteLength(sent[1].text)<=65536);
  await reporter.close();
});

test('opaque secrets use the trust scanner’s environment-name policy before any upload', async () => {
  const keys=['AUTHORIZATION','PRIVATE_KEY','SESSION_KEY','NPM_CONFIG__AUTH'];
  const saved=new Map(keys.map(key=>[key,process.env[key]]));
  try {
    keys.forEach((key,i)=>{process.env[key]='opaqueLenderPrivateCanary'+i;});
    const sent=[],publisher=createTranscriptPublisher({send:async entry=>sent.push(entry)});
    publisher.append(message(keys.map(key=>process.env[key]).join(' ')));await publisher.settled();await publisher.close();
    assert.doesNotMatch(sent[0].text,/opaqueLenderPrivateCanary/);
  } finally {for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;}
});

test('tool returns, shell edit bodies and structured identity output stay on the lender', () => {
  const relay=createRelayTranscript();
  relay.append(line({type:'assistant',message:{content:[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'/workspace/a.js'}}]}}));
  for(const content of ['- EDIT_OLD_CANARY\n+ EDIT_NEW_CANARY',[{type:'text',text:'{"account_id":"ACCOUNT_CANARY","session_id":"SESSION_CANARY"}'}]])
    relay.append(line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'edit',content}]}}));
  relay.append(line({type:'assistant',message:{content:[{type:'tool_use',id:'shell',name:'Bash',input:{command:"cat <<'EOF' > a.js\nSHELL_EDIT_CANARY\nEOF"}}]}}));
  relay.append(line({type:'item.completed',item:{type:'command_execution',id:'codex',command:'npm test',aggregated_output:'{"account_id":"CODEX_ACCOUNT_CANARY"}',exit_code:0}}));
  relay.append(message('{"account_id":"PROSE_ACCOUNT_CANARY","session_id":"PROSE_SESSION_CANARY"}'));
  const snapshot=relay.snapshot();
  assert.doesNotMatch(snapshot.text,/EDIT_OLD_CANARY|EDIT_NEW_CANARY|ACCOUNT_CANARY|SESSION_CANARY|SHELL_EDIT_CANARY/);
  assert.match(snapshot.text,/npm test/);
});

test('only the configured lender home is private in a live snapshot', () => {
  const relay=createRelayTranscript({home:'/srv/private-lender-home'});
  const unrelated='/root/.config/example.json ~/project C:\\Users\\Other\\project /home/x/repo';
  relay.append(message('/srv/private-lender-home/settings/account.json '+unrelated));
  const record=JSON.parse(relay.snapshot().text);
  assert.equal(record.type,'transcript.withheld');
  assert.doesNotMatch(relay.snapshot().text,/private-lender-home/);
  const safe=createRelayTranscript({home:'/srv/private-lender-home'});safe.append(message(unrelated));
  assert.equal(JSON.parse(safe.snapshot().text).message.content[0].text,unrelated);
});

test('explicit secret environment names protect values even when the trust heuristic treats them as examples', async () => {
  const samples={API_KEY:'qYwErTyUiOpAsDfGhJkLzXcV',AUTHORIZATION:'qYwErTyUiOpAsDfGhJkLzXcV',PASSWORD:'Synthet1c(R2)!Canary',SESSION_KEY:'aB7cD9eF'};
  const saved=new Map(Object.keys(samples).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,samples);
    const sent=[],publisher=createTranscriptPublisher({send:async entry=>sent.push(entry)});
    publisher.append(message(Object.values(samples).join(' ')));await publisher.settled();await publisher.close();
    for(const value of Object.values(samples))assert.equal(sent[0].text.includes(value),false);
  } finally {for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;}
});

test('text cleanup cannot reconstruct secrets, identity metadata or home paths after privacy checks', async () => {
  const secret='qYwErTyUiOpAsDfGhJkLzXcV';
  for(const control of ['\u0000','\u0008','\u001b','\u007f']) {
    const sent=[],publisher=createTranscriptPublisher({privateValues:[secret],send:async entry=>sent.push(entry)});
    publisher.append(message(secret.slice(0,12)+control+secret.slice(12))+
      message('{"acc'+control+'ount_id":"NORMALIZED_ACCOUNT_CANARY"}')+
      message('/ro'+control+'ot/.config/NORMALIZED_HOME_CANARY/account.json')+
      message('Readable activity survives.'));
    await publisher.settled();await publisher.settled();await publisher.close();
    for(const entry of sent)assert.doesNotMatch(entry.text,/qYwErTyUiOpAsDfGhJkLzXcV|NORMALIZED_ACCOUNT_CANARY|NORMALIZED_HOME_CANARY/);
    assert.match(sent[0].text,/Readable activity survives/);
  }
});

test('relay withholds prose when the pre-stream credential inventory is unavailable',()=>{
 const relay=createRelayTranscript({scanUnavailable:true});
 relay.append(message('Provider prose'));
 assert.match(relay.snapshot().text,/private details withheld/);
 assert.doesNotMatch(relay.snapshot().text,/Provider prose/);
});

test('relay tool paths remove only the exact workspace root',()=>{
 const relay=createRelayTranscript();
 for(const path of ['/workspace/src/parse.js','/workspace-other/src/parse.js'])relay.append(line({type:'assistant',message:{content:[{type:'tool_use',id:path,name:'Read',input:{file_path:path}}]}}));
 relay.append(line({type:'item.completed',item:{type:'file_change',id:'file',changes:[{path:'/workspace/src/new.js'}]}}));
 const rows=relay.snapshot().text.trim().split('\n').map(JSON.parse);
 assert.equal(rows[0].message.content[0].input.file_path,'src/parse.js');
 assert.equal(rows[1].message.content[0].input.file_path,'','an absolute path outside the exact workspace is stripped');
 assert.equal(rows[2].item.changes[0].path,'src/new.js');
});

for(const [name,event,key,known] of [
 ['timestamp',{type:'result',result:'Safe final',timestamp:'2026-10-21T00:00:00Z'},'timestamp','2026-10-21T00:00:00Z'],
 ['elapsed seconds',{type:'tool_progress',parent_tool_use_id:'tool',elapsed_time_seconds:42817},'elapsed_time_seconds','42817'],
 ['exit code',{type:'item.completed',item:{id:'cmd',type:'command_execution',command:'npm test',exit_code:42817}},'exit_code','42817'],
 ['result error fact',{type:'result',result:'Safe final',is_error:true},'is_error','true'],
 ['tool error fact',{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',is_error:true}]}},'is_error','true']
])test('relay drops only a matching private '+name,()=>{
 const relay=createRelayTranscript({privateValues:[known]});relay.append(line(event));
 const projected=JSON.parse(relay.snapshot().text);
 const facts=projected.item??projected.message?.content[0]??projected;
 assert.equal(Object.hasOwn(facts,key),false);
 assert.equal(projected.type,event.type);
 assert.doesNotMatch(relay.snapshot().text,/transcript\.withheld/);
 const safe=createRelayTranscript({privateValues:[]});safe.append(line(event));
 const ordinary=JSON.parse(safe.snapshot().text),ordinaryFacts=ordinary.item??ordinary.message?.content[0]??ordinary;
 assert.equal(ordinaryFacts[key],key==='exit_code'?event.item.exit_code:key==='is_error'?true:event[key]);
});
test('relay drops unbounded tool descriptions, patterns, URLs and queries',()=>{
 const relay=createRelayTranscript();
 for(const name of ['Bash','Task','Grep','WebFetch','WebSearch'])relay.append(line({type:'assistant',message:{content:[{type:'tool_use',id:name,name,input:{
 command:'npm test',file_path:'src/file.js',description:'DESCRIPTION_CANARY',pattern:'PATTERN_CANARY',url:'https://example.test/URL_CANARY',query:'QUERY_CANARY'
 }}]}}));
 const out=relay.snapshot().text;
 assert.doesNotMatch(out,/DESCRIPTION_CANARY|PATTERN_CANARY|URL_CANARY|QUERY_CANARY/);
 assert.match(out,/npm test/);assert.match(out,/src\/file\.js/);
});
