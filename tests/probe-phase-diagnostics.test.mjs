import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {probeFailureCopy} from '../lib/v1/lending-status-copy.mjs';
import {createDiagnosticLog} from '../lib/v1/diagnostic-log.mjs';
import {createProbeDiagnostics, sanitizeProbePhase, sanitizeProbeDiagnostics} from '../lib/v1/probe-diagnostics.mjs';

test('subcause projection is closed, numeric exits are bounded, and historical log rows are reprojected', async () => {
  const d = createProbeDiagnostics();
  const p = d.start('create_ready');
  d.end(p, 'failed', {subcause: 'credential_store', exit_code: 7});
  const phase = d.finish().phases[0];
  assert.equal(phase.subcause, 'credential_store');
  assert.equal(phase.exit_code, 7);
  const secret = 'HOME=/private token=synthetic argv=prompt';
  for (const value of [secret, 'unknown'.repeat(10000), {secret}]) {
    const safe = sanitizeProbePhase({...phase, subcause: value, stderr: secret});
    assert.equal(safe.subcause, 'unknown');
    assert.doesNotMatch(JSON.stringify(safe), /HOME|private|token|argv|prompt/);
  }
  for (const value of ['7', NaN, Infinity, 1.5, 2147483648, -2147483649, {secret}])
    assert.equal(sanitizeProbePhase({...phase, exit_code: value}).exit_code, undefined);
  for (const value of [-2147483648, 0, 255, 2147483647])
    assert.equal(sanitizeProbePhase({...phase, exit_code: value}).exit_code, value);
  assert.equal(sanitizeProbePhase({...phase, outcome: 'ok'}).subcause, undefined);
  const files = new Map([['log', JSON.stringify({code: 'probe_phase', ...phase, subcause: secret, exit_code: secret, stderr: secret})+'\n']]);
  const fs = {readFile: async p => files.get(p) ?? '', writeFile: async (p,b) => files.set(p,b),
    rename: async (a,b) => { files.set(b,files.get(a)); files.delete(a); }};
  const log = createDiagnosticLog({file:'log', fs, redactor: () => s => s.replaceAll(secret, '[redacted]')});
  await log({code:'probe_phase', ...phase, argv:secret, message:secret});
  const rows = files.get('log').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].subcause, 'unknown');
  assert.equal(rows[0].exit_code, undefined);
  assert.equal(rows[1].subcause, 'credential_store');
  assert.equal(rows[1].exit_code, 7);
  assert.equal(rows[1].message, '[redacted]');
  assert.doesNotMatch(files.get('log'), /HOME|private|token|argv|prompt/);
  const bounded = createProbeDiagnostics();
  for (let i=0;i<25;i++) bounded.end(bounded.start('create_ready'), 'failed', {subcause: secret.repeat(10000), exit_code: Infinity});
  const receipt = bounded.finish();
  assert.equal(receipt.phases.length, 24);
  assert.ok(sanitizeProbeDiagnostics(receipt));
  assert.ok(Buffer.byteLength(JSON.stringify(receipt))<=8192);
  let tick=0;
  const maximal=createProbeDiagnostics({provider:'claude',purpose:'native_identity',generation:Number.MAX_SAFE_INTEGER,
    job_digest:'a'.repeat(64),attempt_id:'b'.repeat(128),monotonic:()=>tick});
  for(let i=0;i<24;i++) {
    tick=85000000;
    const phase=maximal.start('storage_qualification',{subject:'qualification',budgetMs:1000000,deadlineSource:'sandbox_wall'});
    maximal.end(phase,'failed',{subcause:'credential_scope_unenforceable',exit_code:-2147483648});
  }
  const capped=maximal.finish();
  assert.equal(capped.phases.length,24,'optional failure detail cannot erase the receipt');
  assert.equal(capped.phases[0].subcause,'credential_scope_unenforceable','prefer earliest failure detail');
  assert.equal(capped.phases[0].exit_code,-2147483648);
  assert.ok(Buffer.byteLength(JSON.stringify(capped))<=8192);
  assert.deepEqual(sanitizeProbeDiagnostics(capped),capped);
});

test('owner status names a fixed failing phase, not just the coarse reason',()=>{
  const copy=probeFailureCopy({outcome:'failed',reason:'timeout',failed_phase:'storage_qualification'});
  assert.match(copy.line,/checking sandbox storage/i);
  assert.doesNotMatch(copy.line,/token|stderr/i);
});

test('private phase events retain the exact bounded timing fields',async()=>{
  const files=new Map();
  const fs={readFile:async p=>files.get(p)??'',writeFile:async(p,b)=>files.set(p,b),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);}};
  const log=createDiagnosticLog({file:'private',fs,redactor:()=>s=>s});
  await log({code:'probe_phase',probe_id:'00000000-0000-4000-8000-000000000001',phase:'create_ready',subject:'probe',
    purpose:'allowance',generation:7,sequence:1,outcome:'failed',started_at:'2026-11-08T00:00:00.000Z',ended_at:'2026-11-08T00:00:01.000Z',
    start_elapsed_ms:0,end_elapsed_ms:1000,effective_deadline_elapsed_ms:180000,deadline_source:'sandbox_wall',
    argv:'secret command',stderr:'secret output'});
  const row=JSON.parse(files.get('private').trim());
  assert.equal(row.effective_deadline_elapsed_ms,180000);
  assert.equal(row.purpose,'allowance');assert.equal(row.generation,7);
  assert.equal(row.outcome,'failed');assert.equal(row.sequence,1);
  assert.equal(row.argv,undefined);assert.equal(row.stderr,undefined);
});
