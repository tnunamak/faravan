import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const lenderUrl = new URL('../lib/v1/lender.mjs', import.meta.url).href;
for (const [name, callback] of [
  ['return', '() => {}'],
  ['resolve', '() => Promise.resolve()'],
  ['throw', '() => { throw new Error("observer threw"); }'],
  ['reject', '() => Promise.reject(new Error("observer rejected"))'],
  ['never settle', '() => new Promise(() => {})'],
]) test('advisory event callback cannot stop the process: ' + name, () => {
  const program = `import {createLender} from ${JSON.stringify(lenderUrl)};
    const lender=createLender({client:{},backend:{lenderCapabilities(){},admitJob(){}},
      policy:{storage:{get(){},set(){}}},onEvent:${callback}});
    lender.pause(); setImmediate(() => process.stdout.write('continued'));`;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', program],
    {encoding:'utf8', timeout:5000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'continued');
});
