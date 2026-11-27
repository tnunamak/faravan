import './helpers/no-browser.mjs';
// The MCP adapter's own duties for registry operations: folder inputs cross to the app only as checked real paths,
// a cancelled confirmation never runs the operation, and resource reads are bounded requests that cannot crash it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runMcpServer, mcpRoots } from '../lib/v1/mcp.mjs';
import { opError } from '../lib/v1/ops/execute.mjs';
import { resolveJobRecipient } from '../lib/v1/job-recipient.mjs';
import {createOpsClient} from '../lib/v1/ops/execute.mjs';
import {makeRepo} from './helpers/git-guest.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
const approvedCircle = circle => ({...circle,enrollment:{state:'approved'},rosterMembershipVerified:true});
const CIRCLES=[approvedCircle({id:'Friends',name:'Friends',origin:'https://example.test'})];

test('FARAVAN_MCP_ROOTS selects checked folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-mcp-roots-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  assert.deepEqual(mcpRoots({env:{FARAVAN_MCP_ROOTS:root}, cwd:'/'}), [await realpath(root)]);
});

function server(t, options) {
  // The fake app has no standing permission unless a test enables one. The
  // adapter must ask it first; only confirmed requests reach the fake effect.
  if(options.opsClient){
    const supplied=options.opsClient;
    options={...options,opsClient:{...supplied,call:async(id,input,opts)=>{
      if(['jobs.submit','jobs.send_and_wait','jobs.apply'].includes(id)&&opts?.confirmed!==true&&!options.agentPermission)
        throw opError('confirmation_required',428,'Confirm this operation.');
      return supplied.call(id,input,opts);
    }}};
  }
  const input = new PassThrough(), output = new PassThrough(), seen = [], waiting = new Map();
  let buffer = '', id = 0;
  output.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      seen.push(message);
      if (!message.method && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  const running = runMcpServer({input, output, cwd:tmpdir(), ...options});
  t.after(async () => { input.end(); await running; });
  const write = value => input.write(JSON.stringify(value) + '\n');
  const request = (method, params = {}, n = ++id) => new Promise(resolve => { waiting.set(n, resolve); write({jsonrpc:'2.0', id:n, method, params}); });
  return {seen, write, request, init:capabilities => request('initialize', {protocolVersion:'2025-11-25', capabilities, clientInfo:{name:'t', version:'1'}})};
}

test('MCP sends through the app without elicitation when the app permits it',async t=>{
  const calls=[],peer=server(t,{agentPermission:true,opsClient:{call:async(id,input,opts)=>{
    if(id==='circles.list')return CIRCLES;
    calls.push({id,input,opts});return {jobDigest:'sha256:'+'a'.repeat(64)};
  }}});
  await peer.init({elicitation:{}});
  const result=await peer.request('tools/call',{name:'jobs_submit',arguments:{circle:'Friends',prompt:'Fix it',noSource:true,result:{kind:'message'}}});
  assert.equal(result.result.isError,undefined);
  assert.equal(calls[0].opts.confirmed,false);
  assert.equal(peer.seen.some(m=>m.method==='elicitation/create'),false);
});

test('MCP permission operation is disable-only against a real app', {timeout:120000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const handoff=await fetch(owner.app.handoffUrl(),{redirect:'manual'});await handoff.text();
  await api(owner.app,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',token:null,headers:{cookie:handoff.headers.get('set-cookie').split(';')[0],origin:owner.app.origin},body:{enabled:true}});
  assert.equal((await api(owner.app,'/api/lending')).agentBorrowing[circle.id],true);
  const peer=server(t,{opsClient:createOpsClient({home:owner.home,autostart:false})});
  await peer.init({elicitation:{}});
  const listed=await peer.request('tools/list');
  const schema=listed.result.tools.find(x=>x.name==='circles_set_agent_borrowing').inputSchema;
  assert.deepEqual(schema.properties.enabled.enum,[false]);
  assert.equal(schema.properties.confirm,undefined);
  const enable=await peer.request('tools/call',{name:'circles_set_agent_borrowing',arguments:{circle:circle.id,enabled:true}});
  assert.equal(enable.result.isError,true);
  const disable=await peer.request('tools/call',{name:'circles_set_agent_borrowing',arguments:{circle:circle.id,enabled:false}});
  assert.equal(disable.result.isError,undefined);
  assert.notEqual((await api(owner.app,'/api/lending')).agentBorrowing[circle.id],true);
  assert.equal(peer.seen.some(m=>m.method==='elicitation/create'),false);
});

test('unconfirmed MCP sends stay in the server working repository',async t=>{
  const a=await makeRepo(),b=await makeRepo();t.after(()=>Promise.all([a,b].map(r=>rm(r.dir,{recursive:true,force:true}))));
  const calls=[],peer=server(t,{cwd:join(a.dir,'src'),roots:[a.dir,b.dir],agentPermission:true,opsClient:{call:async(id,input)=>{
    if(id==='circles.list')return CIRCLES;calls.push(input);return {jobDigest:'sha256:'+'a'.repeat(64)};
  }}});
  await peer.init({});
  const send=(path,confirm)=>peer.request('tools/call',{name:'jobs_submit',arguments:{circle:'Friends',prompt:'x',repo:{path},...(confirm?{confirm:true}:{})}});
  const refused=await send(b.dir);
  assert.equal(refused.result.isError,true);
  assert.equal(calls.length,0);
  assert.equal((await send(a.dir)).result.isError,undefined);
  assert.equal((await send(b.dir,true)).result.isError,undefined);
});



test('MCP exposes the existing requested budget and forwards effort without inventing USD',async t=>{
  const calls=[],peer=server(t,{opsClient:{call:async(id,input)=>{
    if(id==='circles.list')return CIRCLES;
    calls.push({id,input});return {jobDigest:'sha256:'+'a'.repeat(64)};
  }}});
  await peer.init({});
  const listed=await peer.request('tools/list');
  const schema=listed.result.tools.find(tool=>tool.name==='jobs_submit').inputSchema;
  assert.ok(schema.properties.budget_v1.properties.effort.enum.includes('high'));
  const args={circle:'Friends',prompt:'Think carefully',noSource:true,result:{kind:'message'},model:'synthetic-model',confirm:true};
  const result=await peer.request('tools/call',{name:'jobs_submit',arguments:{...args,budget_v1:{effort:'high'}}});
  assert.notEqual(result.result.isError,true);
  assert.equal(calls[0].input.model,'synthetic-model');
  assert.deepEqual(calls[0].input.budget_v1,{effort:'high'});
  const omitted=await peer.request('tools/call',{name:'jobs_submit',arguments:args});
  assert.notEqual(omitted.result.isError,true);
  assert.equal(calls[1].input.budget_v1,undefined);
  for(const budget_v1 of [{effort:'ultra'},{effort:null},{max_list_usd:0},{max_list_usd:100001},{effort:'high',unknown:true},null]) {
    const refused=await peer.request('tools/call',{name:'jobs_submit',arguments:{...args,budget_v1}});
    assert.equal(refused.result.isError,true);
  }
  assert.equal(calls.length,2,'invalid budgets never dispatch');
});

test('MCP submit errors preserve unknown outcome and the host operation key', async t => {
  const operationKey = 'mcp-host-key-1023';
  const peer = server(t, {opsClient:{call:async id => {
    if (id === 'circles.list') return CIRCLES;
    throw opError('network_error',503,'The host response was lost.',{outcome:'unknown',operationKey});
  }}});
  await peer.init({});
  const result = await peer.request('tools/call',{name:'jobs_submit',arguments:{
    circle:'Friends',prompt:'Send one job',git:{url:'https://example.test/project.git',commit:'a'.repeat(40)},confirm:true,
  }});
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.outcome, 'unknown');
  assert.equal(result.result.structuredContent.operationKey, operationKey);
});

test('circles MCP resource exposes the same unknown membership phase and safe retry intent',async t=>{
  const projection={schemaVersion:3,kind:'membership',phase:'unknown',
    evidence:{enrollmentState:null,origin:true,rosterMembershipVerified:false},invitationPolicy:'each'};
  const circle={id:'circle',name:'Friends',origin:'https://example.test',membershipProjection:projection,
    joinIntent:{outcome:'unknown',createdAt:'2026-10-23T12:00:00Z'}};
  const peer=server(t,{opsClient:{call:async id=>id==='circles.list'?[circle]:[]}});
  await peer.init({});
  const reply=await peer.request('resources/read',{uri:'faravan://circles'});
  assert.deepEqual(JSON.parse(reply.result.contents[0].text),[circle]);
});

test('folder inputs reach the app as checked real paths, never as the client wrote them', async t => {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'faravan-ops-mcp-'));
  t.after(() => rm(base, {recursive:true, force:true}));
  const root = join(base, 'projects'), repo = join(root, 'app');
  await mkdir(repo, {recursive:true}); execFileSync('git', ['init', '-q', repo]);
  await symlink(repo, join(root, 'link'));
  const calls = [];
  const peer = server(t, {roots:[root], opsClient:{call:async (id, input) => { if(id==='circles.list')return CIRCLES;calls.push({id, input}); return {jobDigest:'sha256:' + 'a'.repeat(64)}; }}});
  await peer.init({});
  const call = args => peer.request('tools/call', {name:'jobs_submit', arguments:{circle:'Friends',...args}});
  assert.equal((await call({prompt:'x', repo:{path:join(root, 'link')}, confirm:true})).result.isError, undefined);
  assert.equal(calls[0].input.repo.path, repo, 'the symlink was resolved before it crossed to the app');
  const outside = await call({prompt:'x', repo:{path:base}, confirm:true});
  assert.equal(outside.result.isError, true);
  assert.equal((await peer.request('tools/call', {name:'repo_inspect', arguments:{path:join(root, 'link', '..', 'app')}})).result.isError, undefined);
  assert.equal(calls[1].input.path, repo);
  assert.equal(calls.length, 2, 'a refused folder never reached the app');
});

for (const name of ['jobs_submit', 'jobs_send_and_wait', 'submit_job', 'ops_call']) {
  test(name + ' requires consent before dispatch and accepts only explicit confirmation', async t => {
    const calls = [];
    const sent = {jobDigest:'sha256:' + 'a'.repeat(64)};
    const peer = server(t, {toolsets:['all','meta'], opsClient:{call:async (...args) => { if(args[0]==='circles.list')return CIRCLES;calls.push(args); return sent; }},
      operations:{prepareSend:async args=>resolveJobRecipient(args,CIRCLES),submit:async args => { calls.push(args); return sent; }}});
    await peer.init({});
    const input = {circle:'Friends', prompt:'Fix it', git:{url:'https://example.test/app.git', commit:'a'.repeat(40)}};
    const args = name === 'submit_job' ? {...input, git:input.git.url, commit:input.git.commit} :
      name === 'ops_call' ? {id:'jobs.submit', input} : input;
    const invoke = extra => peer.request('tools/call', {name, arguments:{...args, ...extra}});
    const refused = (await invoke({})).result;
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.code, 'confirmation_required');
    assert.match(refused.structuredContent.effect, /app.git.*prompt.*Friends.*lenders/);
    assert.equal(calls.length, 0);
    assert.equal((await invoke({confirm:true})).result.isError, undefined);
    assert.equal(calls.length, 1);
    if (name === 'submit_job') assert.equal(Object.hasOwn(calls[0], 'confirm'), false);
    else { assert.equal(calls[0][2].confirmed, true); assert.equal(Object.hasOwn(calls[0][1], 'confirm'), false); }
  });
}

for (const name of ['jobs_submit', 'submit_job']) {
  test(name + ' binds an explicit circle name before asking, refusing a replacement with that name', async t => {
    let circles=[approvedCircle({id:'original',name:'Friends',origin:'https://friends.example'})];
    const writes=[];
    const peer=server(t,{opsClient:{call:async(id,...args)=>id==='circles.list'?circles:writes.push({id,args})},
      operations:{prepareSend:async args=>resolveJobRecipient(args,circles),submit:async args=>writes.push(args)}});
    await peer.init({elicitation:{}});
    const git={url:'https://example.test/app.git',commit:'a'.repeat(40)};
    const pending=peer.request('tools/call',{name,arguments:{circle:'Friends',prompt:'Fix it',...(name==='submit_job'?{git:git.url,commit:git.commit}:{git})}});
    const asked=await waitFor(()=>peer.seen.find(m=>m.method==='elicitation/create'),'named-circle consent');
    circles=[approvedCircle({id:'replacement',name:'Friends',origin:'https://other.example'})];
    peer.write({jsonrpc:'2.0',id:asked.id,result:{action:'accept',content:{confirm:true}}});
    assert.equal((await pending).result.structuredContent.code,'circle_changed');
    assert.deepEqual(writes,[]);
  });

  test(name + ' names the default before elicitation and refuses if it changes', async t => {
    let selected='friends';
    const circles=()=>[approvedCircle({id:'friends',name:'Friends',origin:'https://friends.example',selected:selected==='friends'}),
      approvedCircle({id:'work',name:'Work',origin:'https://work.example',selected:selected==='work'})];
    const writes=[];
    const peer=server(t,{opsClient:{call:async(id,...args)=>id==='circles.list'?circles():writes.push({id,args})},
      operations:{prepareSend:async args=>resolveJobRecipient(args,circles()),submit:async args=>writes.push(args)}});
    await peer.init({elicitation:{}});
    const git={url:'https://example.test/app.git',commit:'a'.repeat(40)};
    const pending=peer.request('tools/call',{name,arguments:{prompt:'Fix it',...(name==='submit_job'?{git:git.url,commit:git.commit}:{git})}});
    const asked=await waitFor(()=>peer.seen.find(m=>m.method==='elicitation/create'),'default-circle consent');
    assert.match(asked.params.message,/Friends/);
    selected='work';
    peer.write({jsonrpc:'2.0',id:asked.id,result:{action:'accept',content:{confirm:true}}});
    const refused=(await pending).result;
    assert.equal(refused.isError,true);assert.equal(refused.structuredContent.code,'circle_changed');
    assert.deepEqual(writes,[]);
  });

  test(name + ' honours accepted, declined and cancelled elicitation', async t => {
    const calls = [];
    const sent = {jobDigest:'sha256:' + 'a'.repeat(64)};
    const peer = server(t, {opsClient:{call:async (...args) => { if(args[0]==='circles.list')return CIRCLES;calls.push(args); return sent; }},
      operations:{prepareSend:async args=>resolveJobRecipient(args,CIRCLES),submit:async args => { calls.push(args); return sent; }}});
    await peer.init({elicitation:{}});
    const git = {url:'https://example.test/app.git', commit:'a'.repeat(40)};
    const args = {circle:'Friends', prompt:'Fix it', ...(name === 'submit_job' ? {git:git.url, commit:git.commit} : {git})};
    for (const [n, action] of [[10, 'decline'], [11, 'accept'], [12, 'cancel']]) {
      const before = peer.seen.length;
      const response = peer.request('tools/call', {name, arguments:args}, n);
      const asked = await waitFor(() => peer.seen.slice(before).find(m => m.method === 'elicitation/create'), 'send elicitation');
      assert.match(asked.params.message, /app.git.*Friends.*lenders/);
      if (action === 'cancel') peer.write({jsonrpc:'2.0', method:'notifications/cancelled', params:{requestId:n}});
      peer.write({jsonrpc:'2.0', id:asked.id, result:{action:action === 'decline' ? 'decline' : 'accept', content:{confirm:true}}});
      if (action !== 'cancel') assert.equal((await response).result.isError === true, action === 'decline');
      else { await peer.request('ping'); await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(calls.length, 1, 'only the accepted, uncancelled send ran');
  });
}

test('cancelling a tool call while the person is asked never runs the operation', async t => {
  const calls = [];
  const peer = server(t, {opsClient:{call:async id => { calls.push(id); return []; }}});
  await peer.init({elicitation:{}});
  peer.write({jsonrpc:'2.0', id:7, method:'tools/call', params:{name:'agents_select', arguments:{id:'codex', useForLending:true}}});
  const asked = await waitFor(() => peer.seen.find(m => m.method === 'elicitation/create'), 'elicitation request');
  peer.write({jsonrpc:'2.0', method:'notifications/cancelled', params:{requestId:7}});
  peer.write({jsonrpc:'2.0', id:asked.id, result:{action:'accept', content:{confirm:true}}});
  assert.deepEqual((await peer.request('ping')).result, {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(calls, [], 'the cancelled request did not run');
  assert.equal(peer.seen.some(m => m.id === 7), false, 'and got no response');
});

test('a malformed resource URI is not found, and the server keeps serving', async t => {
  const peer = server(t, {opsClient:{call:async () => ({enabled:false})}});
  await peer.init({});
  assert.equal((await peer.request('resources/read', {uri:'faravan://jobs/%ZZ'})).error.code, -32002);
  assert.equal(JSON.parse((await peer.request('resources/read', {uri:'faravan://lending'})).result.contents[0].text).enabled, false); // legacy resource URI alias
  assert.equal(JSON.parse((await peer.request('resources/read', {uri:'faravan://lending'})).result.contents[0].text).enabled, false);
  const listed = await peer.request('resources/templates/list');
  assert.ok(listed.result.resourceTemplates.some(r => r.uriTemplate === 'faravan://jobs/{digest}'));
});

test('new source operations accept plain folders within roots while applying changes still requires Git',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'faravan-plain-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const folder=join(root,'notes');await mkdir(folder);
 const calls=[],peer=server(t,{roots:[root],opsClient:{call:async(id,input)=>{if(id==='circles.list')return CIRCLES;calls.push({id,input});return {jobDigest:'sha256:'+'a'.repeat(64)};}}});
 await peer.init({});
 const invoke=(name,args)=>peer.request('tools/call',{name,arguments:args});
 assert.equal((await invoke('repo_inspect',{path:folder})).result.isError,undefined);
 assert.equal((await invoke('jobs_submit',{circle:'Friends',prompt:'Read my notes',repo:{path:folder},confirm:true})).result.isError,undefined);
 assert.equal(calls[0].input.path,folder);assert.equal(calls[1].input.repo.path,folder);
 assert.equal((await invoke('jobs_apply',{circle:'Friends',digest:'sha256:'+'a'.repeat(64),repo:folder,confirm:true})).result.isError,true);
 assert.equal(calls.length,2,'Git apply guard refuses before dispatch');
});

test('folders.list accepts a plain parent within roots while preserving root and symlink boundaries',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'faravan-folders-mcp-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const repos=join(root,'projects');await mkdir(repos);
 const repo=join(repos,'app');await mkdir(repo);execFileSync('git',['init','-q',repo]);
 const outside=await mkdtemp(join(await realpath(tmpdir()),'faravan-folders-outside-'));
 t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,join(root,'escape'));
 const calls=[],peer=server(t,{roots:[root],opsClient:{call:async(id,input)=>{calls.push({id,input});return {path:input.path,home:root,folders:[]};}}});
 await peer.init({});
 const invoke=path=>peer.request('tools/call',{name:'folders_list',arguments:{path}});
 const listed=await invoke(repos);
 assert.equal(listed.result.isError,undefined);
 assert.deepEqual(calls,[{id:'folders.list',input:{path:repos}}]);
 assert.equal((await invoke(outside)).result.isError,true,'paths outside --root remain blocked');
 assert.equal((await invoke(join(root,'escape'))).result.isError,true,'symlinks outside --root remain blocked');
 assert.equal(calls.length,1,'refused paths never reach the app');
});

test('MCP release requires explicit confirmation before dispatch',async t=>{
  const calls=[];
  const peer=server(t,{opsClient:{call:async(...args)=>{calls.push(args);return {applied:true};}}});
  await peer.init({});
  const call=confirm=>peer.request('tools/call',{name:'lending_release_hold',arguments:{attemptId:'dead',...(confirm===undefined?{}:{confirm})}});
  assert.equal((await call()).result.structuredContent.code,'confirmation_required');
  assert.equal(calls.length,0);
  assert.equal((await call(true)).result.isError,undefined);
  assert.equal(calls.length,1);assert.equal(calls[0][2].confirmed,true);
  assert.deepEqual(calls[0][1],{attemptId:'dead'});
});
