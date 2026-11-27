import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceTranscript} from '../lib/v1/workspace-transcript.mjs';
import {createRelayTranscript} from '../lib/v1/live-transcript.mjs';
import {transcriptFeedVM} from '../ui/v1/src/transcript-feed.mjs';
import {TRANSCRIPT_CLAUDE as claude,TRANSCRIPT_CODEX as codex} from '../ui/v1/src/fixtures/private-transcript-stream.mjs';
const line=e=>JSON.stringify(e)+'\n';
const tool=(name,input)=>({type:'assistant',message:{content:[{type:'tool_use',name,input}]}});
for(const [provider,raw] of [['Claude',claude],['Codex',codex]])for(const channel of ['signed','live'])test(`${provider} ${channel} projection has readable file and command rows without filler`,()=>{
 const projector=workspaceTranscript('/private/scratch',{privateValues:[]});
 const relay=createRelayTranscript({privateValues:[]});relay.append(raw);
 const projected=channel==='signed'?projector.text(raw):relay.snapshot().text;
 const feed=transcriptFeedVM(projected);
 assert.equal(feed.entries.filter(e=>e.kind==='withheld').length,0);
 assert.doesNotMatch(projected,/private details withheld|DO_NOT_EXPORT/);
 assert.ok(feed.entries.some(e=>e.kind==='tool'&&e.target==='src/parse.js'));
 assert.ok(feed.entries.some(e=>e.kind==='tool'&&e.target.startsWith('node --test')));
 assert.ok(feed.entries.some(e=>e.kind==='message'&&e.text==='The parser now handles empty input.'));
 if(provider==='Claude')for(const name of ['Read','Edit'])assert.equal(feed.entries.find(e=>e.tool===name).target,'src/parse.js');
});
for(const channel of ['signed','live'])test(`${channel} tool labels protect known values, encoded text and absolute lender paths`,()=>{
 const raw=[tool('Read',{file_path:'/srv/lender/private/account.json'}),tool('Read',{file_path:'/workspace-other/src/parse.js'}),tool('Read',{file_path:'/workspace/../private/account.json'}),tool('Edit',{file_path:'src/opaque-private-canary.js'}),tool('Bash',{command:'node --test opaque%2dprivate-canary'}),tool('Bash',{command:'cat <<EOF\nPRIVATE_SHELL_BODY\nEOF'})].map(line).join('');
 const w=workspaceTranscript('/private/scratch',{privateValues:['opaque-private-canary']});const r=createRelayTranscript({privateValues:['opaque-private-canary']});r.append(raw);
 const out=channel==='signed'?w.text(raw):r.snapshot().text;
 assert.doesNotMatch(out,/lender|workspace-other|account\.json|opaque|PRIVATE_SHELL_BODY/);
});
for(const channel of ['signed','live'])test(`${channel} unavailable scans withhold each record and render one quiet row`,()=>{
 const raw=[tool('Read',{file_path:'src/parse.js'}),{type:'result',result:42817,is_error:true},{type:'assistant',message:{content:[{type:'text',text:'Private prose'}]}}].map(line).join('');
 const w=workspaceTranscript('/private/scratch',{scanUnavailable:true});const r=createRelayTranscript({scanUnavailable:true});r.append(raw);
 const out=channel==='signed'?w.text(raw):r.snapshot().text;
 assert.doesNotMatch(out,/src\/parse|42817|Private prose|"is_error"/);
 const feed=transcriptFeedVM(out);assert.equal(feed.entries.length,1);assert.equal(feed.entries[0].kind,'withheld');
 assert.doesNotMatch(out,/"type":"assistant"/);
});

for(const channel of ['signed','live'])test(`${channel} file labels reject URI and invisible-prefixed absolute paths`,()=>{
 const paths=['file:///etc/PRIVATE_PATH_CANARY','file:/etc/PRIVATE_PATH_CANARY','sftp://u@host/etc/PRIVATE_PATH_CANARY',...[' ','\u00a0','\u200b','\ufeff','\u0085'].map(prefix=>prefix+'/etc/PRIVATE_PATH_CANARY')];
 const raw=paths.flatMap(file_path=>[tool('Read',{file_path}),{type:'item.completed',item:{type:'file_change',changes:[{path:file_path}]}}]).map(line).join('');
 const w=workspaceTranscript('/private/scratch'),r=createRelayTranscript();r.append(raw);
 const out=channel==='signed'?w.text(raw):r.snapshot().text;
 assert.doesNotMatch(out,/PRIVATE_PATH_CANARY|file:|sftp:/);
});

test('a projected withheld final result cannot restore an earlier claim into a passed handoff',async()=>{
 const {buildHandoff}=await import('../lib/v1/continuation.mjs');
 const raw=[{type:'assistant',message:{content:[{type:'text',text:'Plan: inspect the parser'}]}},{type:'assistant',message:{content:[{type:'text',text:'Finished. Contact bob@example.test'}]}},{type:'result',result:'Finished. Contact bob@example.test'}].map(line).join('');
 const transcript=workspaceTranscript('/private/scratch').text(raw);
 const handoff=buildHandoff({prompt:'Fix parser',transcript});
 assert.equal(handoff.scan.status,'withheld');assert.equal(handoff.agent_claims,'');assert.equal(handoff.objective,'');
 const recovered=buildHandoff({prompt:'Fix parser',transcript:transcript+line({type:'result',result:'Completed the parser fix safely.'})});
 assert.equal(recovered.scan.status,'passed');assert.equal(recovered.agent_claims,'Completed the parser fix safely.');
});

for(const [kind,paths] of [
 ['NFKC path syntax',['／etc／PRIVATE_PATH_CANARY','＼etc＼PRIVATE_PATH_CANARY','ｆｉｌｅ：/etc/PRIVATE_PATH_CANARY','src/．．/．．/PRIVATE_PATH_CANARY','src／PRIVATE_PATH_CANARY','src/PRIVATE_PATH_CANARY．txt','src/PRIVATE_PATH_CANARY：txt']],
 ['encoded path syntax',['&sol;etc/PRIVATE_PATH_CANARY','.&sol;..&sol;..&sol;PRIVATE_PATH_CANARY','&bsol;etc&bsol;PRIVATE_PATH_CANARY','file&colon;/etc/PRIVATE_PATH_CANARY','&amp;sol;etc/PRIVATE_PATH_CANARY','&#47;etc/PRIVATE_PATH_CANARY','%2fetc/PRIVATE_PATH_CANARY',String.raw`\u002fetc/PRIVATE_PATH_CANARY`]],
 ['Unicode separators',['src/\u00a0PRIVATE_PATH_CANARY','src/\u2007PRIVATE_PATH_CANARY','src/\u202fPRIVATE_PATH_CANARY','src/\u1680PRIVATE_PATH_CANARY','src/\u3000PRIVATE_PATH_CANARY','src/PRIVATE_PATH_CANARY ']]
])for(const channel of ['signed','live'])test(channel+' rejects '+kind,()=>{
 const raw=paths.flatMap(file_path=>[tool('Read',{file_path}),{type:'item.completed',item:{type:'file_change',changes:[{path:file_path}]}}]).map(line).join('');
 const w=workspaceTranscript('/private/scratch'),r=createRelayTranscript();r.append(raw);
 const out=channel==='signed'?w.text(raw):r.snapshot().text;
 assert.equal(/PRIVATE_PATH_CANARY/.test(out),false);
 const good=tool('Read',{file_path:'src/readable file.js'}),safe=channel==='signed'?w.text(line(good)):(r.append(line(good)),r.snapshot().text);
 assert.match(safe,/src\/readable file\.js/);
});

for(const channel of ['signed','live'])test(channel+' withholds private values spelled in NFKC-equivalent or invisible-split forms in paths',()=>{
 const privateValues=['PRIVVAL-xk39f'];
 const hidden=['src/ＰＲＩＶＶＡＬ-xk39f.js','src/PRIVVAL－xk39f','src/PRIVVAL͏-xk39f','src/PRIVVALㅤ-xk39f','src/PRIVVAL️-xk39f','src/PRIVVAL-xk39f'];
 const raw=hidden.flatMap(file_path=>[tool('Read',{file_path}),{type:'item.completed',item:{type:'file_change',changes:[{path:file_path}]}}]).map(line).join('');
 const w=workspaceTranscript('/private/scratch',{privateValues}),r=createRelayTranscript({privateValues});r.append(raw);
 const out=channel==='signed'?w.text(raw):r.snapshot().text;
 assert.equal(/xk39f/.test(out),false);
 for(const file_path of ['src/café.js','src/café.js','docs/My Notes.md','日本語/ファイル.js']){
  const good=line(tool('Read',{file_path})),safe=channel==='signed'?w.text(good):(r.append(good),r.snapshot().text);
  assert.ok(safe.includes(JSON.stringify(file_path).slice(1,-1))||safe.includes(file_path),file_path+' must survive');
 }
});
