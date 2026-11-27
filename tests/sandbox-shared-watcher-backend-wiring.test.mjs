import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Exact source slices only. This is not the full backend/credentials graph.
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const slice=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>0&&b>a);return source.slice(a,b);};
test('watcher factory binds current HOME, owner and resolved executable without sharing identities',()=>{
  let home='/test/one',owner='owner-one',binary='/test/sbx',env={HOME:home},calls=[];
  const method=Function('sbxHome','sandboxOwnerScope','resolveSbxExecutable','sbxBin','sbxChildEnv',
    'return ({'+slice('  _sharedSandboxWatcher() {','  async ensureSandboxAdmission(')+'})._sharedSandboxWatcher')(
      ()=>home,()=>owner,(b,e)=>{assert.equal(e,env);return b;},()=>binary,()=>env);
  const backend={_sharedSandboxWatcherFactory:opts=>{calls.push(opts);return {opts};}};
  const first=method.call(backend);assert.equal(first.opts.home,home);assert.equal(first.opts.owner,owner);assert.equal(first.opts.binary(),binary);
  assert.equal(method.call(backend),first);home='/test/two';const second=method.call(backend);assert.notEqual(second,first);assert.equal(second.opts.home,home);
  owner='owner-two';assert.notEqual(method.call(backend),second);assert.equal(calls.length,3);
  binary='/test/new-sbx';assert.equal(calls[2].binary(),binary);
});
for(const mode of ['valid','foreign','unadopted'])test('non-compute retry stays in its bound policy scope: '+mode,async()=>{
  const row={sandbox_id:'wf-0000000000000001',watch_state:mode==='unadopted'?undefined:'watch_adopted'},calls=[];
  const method=Function('removeSandboxGitHub','removeSandboxPolicies','AbortSignal',
    'return ({'+slice('  async _retryWatchedCleanupDebts(','  _noteCleanupListingFailure(')+'})._retryWatchedCleanupDebts')(
      async(run,name)=>{calls.push('github');assert.equal(name,row.sandbox_id);await run(['policy-check']);return true;},
      async(run,name,unused,options)=>{calls.push('policy');assert.equal(name,row.sandbox_id);assert.deepEqual(options,{leaveProvisioned:true});return true;},AbortSignal);
  let commands=0;const backend={cleanupJournal:{authority:()=>row},_rowHomeMatches:()=>mode!=='foreign',_rowRun:async(r,args,{signal})=>{
    assert.equal(r,row);assert.deepEqual(args,['policy-check']);assert.ok(signal);commands++;}};
  assert.deepEqual(await method.call(backend,row),{policy_revoked:mode==='valid'});assert.deepEqual(calls,mode==='valid'?['github','policy']:[]);
  assert.equal(commands,mode==='valid'?1:0);assert.equal(row.compute_stopped,undefined);assert.equal(row.data_cleanup,undefined);
});
test('home response applies the safe cleanup summary at the app boundary',()=>{
  const app=fs.readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  assert.match(app,/import\s*\{cleanupStatusSummary\}\s*from\s*['"]\.\/cleanup-status\.mjs['"]/);
  assert.match(app,/cleanup:\s*cleanupDisplaySummary\(backend\)/);
  assert.match(app,/cleanupStatusSummary\(\(backend\?\.cleanupStatusForDisplay\?\?backend\?\.cleanupStatus\)\?\.call\(backend\)\)/);
});
