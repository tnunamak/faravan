import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {problemForError} from '../lib/v1/cli.mjs';
test('invitation errors describe membership and recovery on CLI, API and MCP',()=>{
 for(const [code,pattern] of [['invitation_revoked',/revoked.*new invitation/i],['enrollment_rejected',/declined.*new invitation/i],['host_update_required',/update.*hosting/i]]){
  const problem=problemForError({code});assert.match(problem.message,pattern);assert.doesNotMatch(problem.message,/agent|work|Interrupted/);
 }
});
