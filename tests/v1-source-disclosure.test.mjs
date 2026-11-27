import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { createJobOperations } from '../lib/v1/cli.mjs';
import * as p from '../lib/protocol/index.mjs';
import { createTar } from '../lib/tar-writer.mjs';
import { runJob } from '../lib/v1/run.mjs';

test('received source artifacts protect every local submission path', {timeout:120000}, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const repo = join(f.root, 'dummy-repo'), folder = join(f.root, 'dummy-folder');
  for (const dir of [repo, folder]) {
    await mkdir(dir);
    await writeFile(join(dir, 'main.js'), 'export const answer = 42;\n');
    await writeFile(join(dir, '.env'), 'FARAVAN_DUMMY_ONLY=fixture-credential-value\n');
    for(const name of ['.env.example','.env.sample','.env.template'])
      await writeFile(join(dir,name),'FARAVAN_DUMMY_ONLY=replace-me\n');
    await mkdir(join(dir,'nested'));
    for(const name of ['.YARNRC.YML','.yarnrc','_NETRC','private.PpK'])
      await writeFile(join(dir,'nested',name),'INERT_AUTH_CANARY='+name);
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {stdio:'pipe'});
  git('init','-q'); git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','dummy fixture');
  const ops = createJobOperations({device:owner.app.device, home:owner.home});
  const inspect = (label, result) => {
    const view = f.jobs.get(result.jobDigest);
    const bytes = gunzipSync(f.artifacts.get(view.job.payload.source.artifact.digest));
    const present = bytes.includes(Buffer.from('fixture-credential-value'));
    t.diagnostic(label + ': received tar dummy credential ' + (present ? 'PRESENT' : 'ABSENT'));
    assert.equal(present, false, label);
    assert.equal(bytes.includes(Buffer.from('INERT_AUTH_CANARY=')),false,label+' auth filenames');
    assert.ok(bytes.includes(Buffer.from('export const answer')), label + ' retains source');
    assert.ok(bytes.includes(Buffer.from('replace-me')), label + ' retains example');
    assert.ok(result.warnings.some(line => /5 files.*not sent.*credentials/i.test(line)), label + ' disclosure');
  };
  const send = (body, route='/api/jobs') => api(owner.app, route, {method:'POST', body:{circle:circle.id,prompt:'Check fixture',...body}, headers:{'faravan-confirm':'yes'}});
  inspect('UI repo HEAD', await send({repo:{path:repo}}));
  inspect('ops jobs.submit repo', await send({repo:{path:repo}}, '/api/ops/jobs.submit'));
  inspect('CLI --source', await ops.submit({source:repo,prompt:'CLI fixture',circle:circle.id}));
  inspect('non-git folder', await ops.submit({source:folder,prompt:'folder fixture',circle:circle.id}));
  const output = []; let sent;
  const run = async extra => {
    const code = await runJob(['Check fixture','--yes','--detach',...extra], {cwd:repo, device:owner.app.device,
      operations:{...ops,submit:async input => {sent=await ops.submit(input);return sent;}}, stdout:{write:s=>output.push(s)},stderr:{write:s=>output.push(s)}});
    assert.equal(code,0,output.join('')); return sent;
  };
  inspect('CLI run HEAD', await run([]));
  await writeFile(join(repo,'main.js'),'export const answer = 43;\n');
  inspect('UI repo working tree', await send({repo:{path:repo,includeUncommitted:true}}));
  inspect('CLI run working tree', await run(['--include-uncommitted']));
  assert.match(output.join(''), /5 files.*not sent.*credentials/i);
});


test('a saved pending source from before filtering cannot upload credential bytes again', {timeout:120000}, async t => {
  const f = await appFixture(t), {owner,circle} = await f.connect();
  const ops = createJobOperations({device:owner.app.device,home:owner.home});
  const safe = createTar([{name:'main.js',data:Buffer.from('safe'),mode:0o644,type:'0'}]);
  const input = {sourceTar:safe,prompt:'legacy retry fixture',circle:circle.id,draftId:'legacy-source-fixture-001'};
  await ops.submit(input);
  const store = owner.app.device.intentStore(circle.id), slot='submit:draft:'+input.draftId;
  const intent=await store.get(slot);
  const unsafe=gzipSync(createTar([{name:'.env',data:Buffer.from('fixture-secret'),mode:0o644,type:'0'}]));
  const payload={...intent.payload,source:{kind:'archive',artifact:{digest:p.digestBytes(unsafe),bytes:unsafe.length,media_type:'application/gzip'}}};
  // This simulates an intent saved before source manifests existed.
  delete payload.source_manifest;
  payload.requirements={...payload.requirements,capabilities:payload.requirements.capabilities.filter(c=>c!=='source_manifest_v1')};
  await store.set(slot,{...intent,state:'pending',payload,jobDigest:p.digest(payload),
    envelope:p.signEnvelope('job',payload,(owner.app.device.deviceKey.privateKey ?? owner.app.device.deviceKey)),
    artifacts:{source:unsafe.toString('base64'),prompt:Buffer.from(input.prompt).toString('base64')}});
  const before=f.rawRequests.length;
  await assert.rejects(()=>ops.submit(input), /saved.*credentials/i);
  assert.ok(!f.rawRequests.slice(before).some(r=>r.method==='PUT' && r.url.includes('/artifacts/')));
  assert.ok(![...f.artifacts.values()].some(bytes=>bytes.equals(unsafe)));
});
