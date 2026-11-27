import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from '../helpers/v1-app-fixture.mjs';
import {OPS} from '../../lib/v1/ops/registry.mjs';
import {check, validate} from '../../lib/v1/ops/schema.mjs';

const unknown = () => ({schemaVersion:1,state:'unknown',jobId:null,attemptId:null,sandboxId:null,observedAtMs:null});
const prepared = () => ({schemaVersion:1,state:'prepared',jobId:'owned-job',attemptId:'owned-attempt',sandboxId:'owned-sandbox',observedAtMs:123});
const canary = 'PRIVATE_PREPARATION_CANARY_DO_NOT_EXPOSE';
const schema = OPS.find(op => op.id === 'readiness.get')?.output;

test('authenticated readiness projects preparation without changing failed readiness or starting work', {timeout:60000}, async t => {
  assert.ok(schema, 'use the real operation output schema');
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  for (const name of ['prepare','start','admitJob']) backend[name] = () => {
    backend.calls.push(['forbidden-effect',name]);
    throw new Error('Readiness must not call ' + name);
  };
  backend.probeCapabilities = async () => {
    backend.calls.push(['probe']);
    return {available:false,preflight:{ok:false,checks:[
      {name:'sbx_install',ok:false,detail:'Synthetic runtime unavailable'},
      {name:'sbx_daemon',ok:false,detail:'Synthetic runtime unavailable'},
      {name:'docker_login',ok:false,detail:'Synthetic runtime unavailable'},
    ]}};
  };
  const {app} = await f.start('preparation-readiness', {backend});
  // appFixture owns and closes apps, loopback servers, and temporary directories.
  const denied = await api(app, '/api/readiness', {token:null,status:401});
  assert.equal(denied.code, 'unauthorized');
  const baseline = await api(app, '/api/readiness?refresh=true');
  assert.equal(baseline.ready, false);
  assert.ok(baseline.checks.some(row => row.ok === false));
  assert.deepEqual(baseline.preparation, unknown(), 'observer capability is optional, response field is not');
  assert.equal(check(schema, baseline), null);
  const failedChecks = baseline.checks.filter(row => row.ok === false);
  const effects = () => backend.calls.filter(([name]) => ['forbidden-effect','admit','prepare','run','clone','collect'].includes(name));
  assert.deepEqual(effects(), []);

  let observation;
  backend.getPreparationObservation = () => observation;
  async function expectProjection(value, expected, label) {
    observation = value;
    const result = await api(app, '/api/readiness');
    assert.deepEqual(result.preparation, expected, label);
    assert.equal(check(schema, result), null, label + ': registry agrees with HTTP');
    assert.equal(validate(schema, result, 'readiness'), result);
    assert.equal(result.ready, false, label + ': not admission evidence');
    assert.deepEqual(result.checks.filter(row => row.ok === false), failedChecks, label + ': runtime failures retained');
    assert.ok(!JSON.stringify(result).includes(canary), label + ': no private fields');
    assert.deepEqual(effects(), [], label + ': read route does not launch/admit');
    return result;
  }
  const positive = await expectProjection({...prepared(),generation:canary,rawHandle:{private:canary},extra:canary}, prepared(), 'prepared positive control');
  await expectProjection({...prepared(),state:'pending',sandboxId:canary}, {...prepared(),state:'pending',sandboxId:null}, 'pending strips sandbox identity');
  await expectProjection(undefined, unknown(), 'producer removed observation');
  await expectProjection({...prepared(),attemptId:'replacement-attempt',sandboxId:'replacement-sandbox'}, {...prepared(),attemptId:'replacement-attempt',sandboxId:'replacement-sandbox'}, 'producer replacement is read fresh');
  await expectProjection(null, unknown(), 'replacement invalidated by producer');
  const invalid = [
    ['empty object', {}],
    ['unknown state', {...prepared(),state:'unknown'}],
    ['unrecognized state', {...prepared(),state:'running'}],
    ['missing job', {...prepared(),jobId:null}],
    ['empty attempt', {...prepared(),attemptId:''}],
    ['oversized job', {...prepared(),jobId:'x'.repeat(257)}],
    ['control in attempt', {...prepared(),attemptId:'bad\nidentity'}],
    ['missing prepared sandbox', {...prepared(),sandboxId:null}],
    ['oversized sandbox', {...prepared(),sandboxId:'x'.repeat(257)}],
    ['negative time', {...prepared(),observedAtMs:-1}],
    ['infinite time', {...prepared(),observedAtMs:Infinity}],
    ['NaN time', {...prepared(),observedAtMs:NaN}],
    ['missing observation time', {...prepared(),observedAtMs:undefined}],
  ];
  for (const [label, value] of invalid) await expectProjection(value, unknown(), label);
  backend.getPreparationObservation = () => {throw new Error(canary);};
  const failedGetter = await api(app, '/api/readiness');
  assert.deepEqual(failedGetter.preparation, unknown());
  assert.equal(failedGetter.ready, false);
  assert.deepEqual(failedGetter.checks.filter(row => row.ok === false), failedChecks);
  assert.equal(check(schema, failedGetter), null);
  assert.ok(!JSON.stringify(failedGetter).includes(canary));
  delete backend.getPreparationObservation;
  await expectProjection(undefined, unknown(), 'removed optional getter');

  // Exercise the real exported validator against actual HTTP output, not a mirrored schema.
  const missing = {...positive}; delete missing.preparation;
  const badOutputs = [
    missing,
    {...positive,preparation:{...positive.preparation,schemaVersion:2}},
    {...positive,preparation:{...positive.preparation,state:'running'}},
    {...positive,preparation:{...positive.preparation,jobId:42}},
    {...positive,preparation:{...positive.preparation,observedAtMs:Infinity}},
    {...positive,preparation:{...positive.preparation,rawHandle:canary}},
    {...positive,preparation:{state:'prepared'}},
  ];
  for (const bad of badOutputs) {
    assert.notEqual(check(schema, bad), null);
    assert.throws(() => validate(schema, bad, 'readiness'), error => error.code === 'invalid_request');
  }
  assert.deepEqual(effects(), []);
});
