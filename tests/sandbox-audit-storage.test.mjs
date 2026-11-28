import {lendingView} from '../ui/v1/src/helpers.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLender } from '../lib/v1/lender.mjs';
import { admitDockerJob, DockerSbxBackend, SBX_RUN_OPTIONS } from '../lib/docker-backend.mjs';
import { createSbxPolicy, sbxRunner } from './helpers/sbx-policy-model.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { lendingBlockers } from '../lib/v1/blockers.mjs';
import { createStoragePool, storageVolumes } from '../lib/sandbox-storage.mjs';
import { JOB_DEFAULTS } from '../lib/v1/job-defaults.mjs';
import { probeFaravanIdentity } from '../lib/executor.mjs';

const GiB = 1024 ** 3;
const diskAt = bytes => ({ free: async () => ({ free: bytes, volumes: [] }) });

test('R3: guest disk qualification does not advertise a host storage ceiling', async () => {
  const backend = new DockerSbxBackend({storage:{available:async()=>true},hostDisk:diskAt(20*GiB)});
  const options = {platformName:'darwin',sbxHomePath:'/Users/a/.wfsbx',userHome:'/Users/a',
    realpathPath:path=>path==='/Users/a/Library/Keychains'||path==='/Users/a/.wfsbx/Library/Keychains'?'/Users/a/Library/Keychains':null,
    runCommand:async (_command,args)=>({code:0,stdout:args[0]==='version'?'sbx version 0.51.0':args[0]==='diagnose'?'Daemon healthy\nDocker authentication healthy':args.join(' ')==='policy ls'?'Policy rules':
      args.join(' ')==='run --help'?SBX_RUN_OPTIONS.map(flag=>'  '+flag+'  option').join('\n'):''})};
  const report = await backend.lenderCapabilities(options);
  assert.equal(report.guest_block_device_capacity, true);
  assert.equal(report.host_storage_protection, false);
  assert.equal(report.enforced_limits.includes('disk_bytes'), false, 'host storage is watched, never advertised as enforced');
  assert.equal(report.available, true, 'unenforced host storage no longer holds all lending');
  assert.equal(report.preflight.checks.some(row=>row.name==='storage_enforcement'), false);
  assert.equal(report.preflight.checks.find(row=>row.name==='host_disk').ok, true);
  const low = await new DockerSbxBackend({storage:{available:async()=>true},hostDisk:diskAt(7*GiB)}).lenderCapabilities(options);
  assert.equal(low.available, false);
  assert.equal(low.reason, 'host_disk_low');
});

test('R3: required host storage is refused even when guest disks are qualified', () => {
  const spec={job_id:'host-storage-required',image:'codex',entrypoint:'true',
    execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
    resources:{cpu:1,memory_mib:512,storage_mib:4096,wall_seconds:60,output_bytes:4096,network_bytes:1,max_processes:1},
    required_limits:['cpu','memory','wall','output','storage'],inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']};
  const result=admitDockerJob(spec,{storage:true});
  assert.equal(result.ok,false);
  assert.equal(result.code,'storage_unenforceable');
});

test('R2: first setup qualifies guest disks once, while lending is available', async () => {
  let qualified=false, probes=0;
  const backend={
    storage:{supported:async()=>true},
    lenderCapabilities:async()=>({available:true,guest_block_device_capacity:qualified,preflight:{ok:true,version:'0.49.2'}}),
    testWorkspace:async()=>{probes++;qualified=true;return {ok:true};},
    prepare:async()=>({_lastExecStdout:'FARAVAN_INSTALLED=1\n{"loggedIn":true,"authMethod":"claude.ai"}\n'}),
    start:async()=>{},destroy:async()=>({removed:true}),
  };
  const report=await probeFaravanIdentity({harnessNames:['claude-code-subscription'],backendFactory:()=>backend,readDockerAccount:async()=>null});
  assert.equal(probes,1);
  assert.equal(report.providers[0].signedIn,true);
});

test('R3: a Codex-only identity qualifies its guest disks with a Codex workspace', async t => {
  const home=await mkdtemp(join(tmpdir(),'wf-codex-qualify-'));
  const oldHome=process.env.FARAVAN_SBX_HOME, oldScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home; process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{ if(oldHome===undefined) delete process.env.FARAVAN_SBX_HOME; else process.env.FARAVAN_SBX_HOME=oldHome;
    if(oldScratch===undefined) delete process.env.FARAVAN_SCRATCH_ROOT; else process.env.FARAVAN_SCRATCH_ROOT=oldScratch; });
  let qualified=false;
  const images=[], policy=createSbxPolicy({globalRules:[]});
  const runner=sbxRunner(policy,args=>({code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):
    args[0]==='exec'?'FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n':''}),
    {kitAllow:[],secretResult:{code:0,stdout:JSON.stringify({secrets:[{type:'service',name:'openai',scope:'global'}],custom_secrets:[],shadowed_services:[],env_only_count:0})}});
  const backend=new DockerSbxBackend({storage:{supported:async()=>true,available:async()=>qualified,reserve:async()=>{},release:async()=>{},verify:async()=>true,recordQualification:async value=>{qualified=value!==false;}},
    runCommand:async(args,options)=>{if(args[0]==='create') { images.push(args.at(-1)); policy.createSandbox(args[args.indexOf('--name')+1]); return {code:0,stdout:''}; } return runner.run(args,options);}});
  backend.lenderCapabilities=async()=>({available:true,guest_block_device_capacity:qualified,preflight:{ok:true,version:'0.49.2'}});
  const report=await probeFaravanIdentity({harnessNames:['codex'],backendFactory:()=>backend,readDockerAccount:async()=>null});
  assert.equal(qualified,true);
  assert.match(images[0],/^docker\.io\/sbx\/codex@sha256:[0-9a-f]{64}$/);
  assert.equal(report.providers[0].signedIn,true);
});

test('R2: Claude state volumes consume the signed disk budget instead of adding to it', () => {
  assert.equal(storageVolumes(8*1024**3,'claude').root,3584*1048576);
  assert.throws(()=>storageVolumes(4*1024**3,'claude'),{code:'storage_unenforceable'});
  assert.equal(JOB_DEFAULTS.limits.disk_bytes,8*1024**3);
});
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('R2: storage reservations survive restart and prevent aggregate overcommit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'storage-pool-')); t.after(()=>rm(home,{recursive:true,force:true}));
  const options = {home:()=>home,run:async()=>({code:0,stdout:'sbx version v0.49.2 abc'}),platform:'linux',freeBytes:async()=>13*1024**3};
  const first = createStoragePool(options);
  assert.equal(await first.supported(), true);
  assert.equal(await first.available(), false, 'version alone is not runtime evidence');
  await first.recordQualification();
  assert.equal(await first.available(), true);
  assert.equal(await first.available('v0.50.0'), false);
  await first.reserve('wf-1111111111111111',4*1024**3);
  const restarted = createStoragePool(options);
  await assert.rejects(restarted.reserve('wf-2222222222222222',4*1024**3),{code:'storage_unenforceable'});
  await restarted.release('wf-1111111111111111');
  await restarted.reserve('wf-2222222222222222',4*1024**3);
});

test('R2: storage evidence rejects writable host mounts, wrong disks and unknown layouts', async () => {
  let writable = false, size = 3584*1048576;
  const pool = createStoragePool({home:()=>'/unused',run:async args=>({code:0,stdout:JSON.stringify(args.includes('lsblk')?
    {blockdevices:[{type:'disk',ro:false,size},{type:'disk',ro:false,size:512*1048576}]}:
    {filesystems:[{target:'/',fstype:'overlay',options:'rw',children:[{target:'/etc/resolv.conf',fstype:'virtiofs',options:writable?'rw':'ro'}]}]})})});
  const handle={sandbox_id:'wf-1111111111111111',_resources:{storage_mib:4096}};
  assert.equal(await pool.verify(handle),true);
  writable=true; assert.equal(await pool.verify(handle),false);
  writable=false; size=20*1024**3; assert.equal(await pool.verify(handle),false);
});

test('setup cannot report lendable while this computer is low on disk, and never claims storage is enforced', () => {
  const ready = {docker: {installed:true,running:true,signedIn:true},intent:{on:true},agents:[{id:'codex',installed:true,signedIn:true}]};
  assert.equal(lendingBlockers(ready).canLend, true, 'unenforced host storage is not a blocker');
  const low = lendingBlockers({ ...ready, readinessRequirements:[{cause:'host_disk',label:'This computer is low on disk space. Faravan lends only with at least 8 GiB free.',
    remedy:'Free up disk space on this computer, then choose Check again.'}] });
  assert.equal(low.canLend, false);
  assert.equal(low.headline, 'Lending stopped: this computer is low on disk space');
  const row = low.items.find(item => item.key === 'readiness_requirement');
  assert.equal(row.label, 'Free disk space', 'a short title, not the explanation twice');
  assert.equal(row.detail, 'This computer is low on disk space. Faravan lends only with at least 8 GiB free. Free up disk space on this computer, then choose Check again.');
  assert.equal(row.action, 'Check again', 'the button is a short action; the instruction stays in the explanation');
  assert.doesNotMatch(JSON.stringify(low), /storage (?:is )?enforced|disk (?:limit|ceiling) enforced/i);
});

test('M5: a preferred disk limit is admitted with storage listed as unenforced, never enforced', { timeout: 60000 }, async t => {
  const f = await lenderFixture(t, { mutateJob: job => { job.requirements.limit_modes = { disk_bytes: 'preferred' }; } });
  f.backend.admitJob = spec => { f.calls.push(['admit', spec]); return admitDockerJob(spec); };
  let witness;
  const reached = new Promise(resolve => { witness = resolve; });
  const prepare = f.backend.prepare.bind(f.backend);
  f.backend.prepare = (...args) => {
    witness({ stage: 'backend prepare' });
    return prepare(...args);
  };
  const controller = new AbortController();
  const onAbort = () => witness({ stage: 'test deadline' });
  t.signal.addEventListener('abort', onAbort, { once: true });
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [], onEvent: event => {
      f.events.push(event);
      if (['declined', 'failed'].includes(event.status))
        witness({ stage: event.status, reason: event.reason ?? event.error ?? event.code });
    } });
  const running = lender.start(controller.signal);
  running.then(
    () => witness({ stage: 'lender exited' }),
    error => witness({ stage: 'lender rejected', reason: error.message }),
  );
  t.after(async () => { controller.abort(); await running; });
  try {
    const outcome = await reached;
    assert.equal(outcome.stage, 'backend prepare', `first admission outcome: ${JSON.stringify(outcome)}`);
  } finally {
    t.signal.removeEventListener('abort', onAbort);
  }
  assert.equal(f.events.some(event => event.status === 'declined'), false);
  const admitted = f.calls.find(([kind]) => kind === 'admit')?.[1];
  assert.ok(admitted, 'successful prepare must have followed admission');
  assert.equal(admitted.required_limits.includes('storage'), false);
  const result = admitDockerJob(admitted);
  assert.equal(result.ok, true);
  assert.equal(result.enforced_limits.includes('storage'), false);
  assert.ok(result.unenforced.includes('storage'));
});

test('R2: qualified storage uses mountless creation and reserves both volumes before creation', async () => {
  const order = [], policy = createSbxPolicy(), runner = sbxRunner(policy, args => ({ code: 0, stdout: args[0] === 'ls' ? '[]' : '' }));
  const backend = new DockerSbxBackend({ storage: {
    available: async () => true,
    reserve: async (id, bytes) => { order.push(['reserve', id, bytes]); },
    verify: async () => true,
    release: async id => { order.push(['release', id]); },
  }, runCommand: async (args, options) => {
    if (args[0] === 'create') { order.push(['create', args, options.env]);
      policy.createSandbox(args[args.indexOf('--name') + 1], { kitAllow: ['api.anthropic.com:443'], denyNetwork: args.flatMap((a, i) => a === '--deny-network' ? [args[i + 1]] : []) });
      return { code: 0, stdout: '' };
    }
    return runner.run(args, options);
  } });
  const spec = { job_id: 'mountless-storage', image: 'claude', entrypoint: 'true',
    execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
    resources: { cpu: 1, memory_mib: 512, storage_mib: 8192, wall_seconds: 60, output_bytes: 4096, network_bytes: 1, max_processes: 1 },
    required_limits: ['cpu', 'memory', 'wall', 'output', 'guest_block_device_capacity'], inputs: [], output_manifest: [], egress: 'internet', provider_hosts: ['**.anthropic.com'] };
  const handle = await backend.prepare(spec);
  try {
    assert.equal(order[0][0], 'reserve');
    assert.equal(order[0][2], 8192 * 1048576);
    const created = order.find(row => row[0] === 'create');
    assert.ok(created);
    assert.equal(created[1].includes(handle.scratch_dir), false, 'no writable host workspace mount');
    assert.equal(created[2].DOCKER_SANDBOXES_ROOT_SIZE, '3584m');
    assert.equal(created[2].DOCKER_SANDBOXES_DOCKER_SIZE, '512m');
    assert.ok(handle._execution.enforced_limits.includes('guest_block_device_capacity'));
    assert.ok(handle._execution.unenforced.includes('storage'));
    await backend.syncWorkspace(handle);
    assert.ok(runner.calls.some(args => args[0] === 'cp' && args[1] === handle.scratch_dir + '/.'));
  } finally { await backend.destroy(handle); }
  assert.equal(order.at(-1)[0], 'release');
  const qualifications=[];
  backend.storage.recordQualification=async value=>qualifications.push(value);
  backend.storage.verify=async()=>false;
  await assert.rejects(backend.prepare({...spec,job_id:'mountless-storage-changed'}),{code:'storage_unenforceable'});
  assert.deepEqual(qualifications,[false],'a changed runtime cannot retain old lendable evidence');
});

test('availability waits on a low disk with its own reason before claiming work', async t => {
  const f = await lenderFixture(t), report = f.backend.lenderCapabilities();
  f.backend.lenderCapabilities = () => ({ ...report, available: false, reason: 'host_disk_low', enforced_limits: report.enforced_limits.filter(k => k !== 'disk_bytes') });
  const controller = new AbortController(), events = [];
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [], onEvent: event => events.push(event) });
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => events.some(event => ['waiting_for_sandbox', 'idle'].includes(event.status)) || f.calls.some(([kind]) => kind === 'prepare'), 'readiness');
  assert.equal(f.calls.some(([kind]) => kind === 'prepare'), false);
  const state = events.find(event => event.status === 'waiting_for_sandbox');
  assert.equal(state.reason,'sandbox_cannot_start');
  assert.equal(lendingView(state).remedy,'Free up disk space on this computer');
  assert.match(lendingView(state).message,/low on disk space/);
  assert.equal(f.count('/jobs/claim-next'),0);
});
