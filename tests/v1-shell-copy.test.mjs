import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {COMMANDS} from '../lib/v1/help.mjs';
const run=promisify(execFile);
test('host help uses circle-name while parser keeps the legacy alias',async()=>{
  assert.match(COMMANDS.host.usage,/--circle-name/);assert.doesNotMatch(COMMANDS.host.usage,/--collective-name/);
  for(const flag of ['--circle-name','--collective-name']) {
    await assert.rejects(run(process.execPath,['bin/faravan','host','--stop',flag,'Example'],{env:{...process.env,FARAVAN_NO_BROWSER:'1'}}),e=>{assert.match(e.stderr,/--stop cannot be combined/);return true;});
  }
});
