import './helpers/no-browser.mjs';
// Scoped source-only regression test. No imports of repository dependencies.
// Run: node --test formatter.test.mjs (REGISTRY_FILE may override the source).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const source = readFileSync(process.env.REGISTRY_FILE || 'lib/v1/ops/registry.mjs', 'utf8');
const start = source.indexOf('export function jobSendEffect(input) {');
const end = source.indexOf('\nconst terminal', start);
assert.ok(start >= 0 && end > start, 'formatter extraction boundaries exist');
const confirm = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '; jobSendEffect');
const parentJob = 'sha256:' + 'a'.repeat(64);
const parentResult = 'sha256:' + 'b'.repeat(64);
for (const id of ['jobs.submit', 'jobs.send_and_wait']) {
  test(id + ': follow-up-only consent identifies the parent job and result', () => {
    const declaration = source.split('\n').find(line => line.includes("op('" + id + "',"));
    assert.ok(declaration?.includes('confirm:jobSendEffect'), 'operation uses tested formatter');
    const input = {prompt:'Continue the delivered work', followup:{parentJob, parentResult}};
    if (id === 'jobs.send_and_wait') input.timeout_seconds = 0;
    let text;
    assert.doesNotThrow(() => { text = confirm(input); });
    assert.ok(text.includes(parentJob));
    assert.ok(text.includes(parentResult));
    assert.match(text, /reconstructed source/);
    assert.match(text, /your selected circle/);
    assert.match(text, /another person's computer/);
    assert.equal(Object.hasOwn(input, 'files'), false);
    assert.match(confirm({...input, circle:'Review circle'}), /to circle "Review circle"/);
  });
}
const suffix = " and the prompt to your selected circle for its lenders to run on another person's computer.";
for (const [label, input, expected] of [
  ['legacy folder', {source:'project'}, 'code from folder "project" (committed HEAD when available; otherwise folder contents)'],
  ['repository', {repo:{path:'project'}}, 'committed HEAD when available, otherwise folder contents from "project"'],
  ['uncommitted repository', {repo:{path:'project',includeUncommitted:true}}, 'folder contents from "project"'],
  ['zip', {zip:{name:'source.zip'}}, 'files from ZIP "source.zip"'],
  ['unnamed zip', {zip:{}}, 'files from ZIP "archive"'],
  ['git', {git:{url:'https://example.invalid/repo',commit:'c'.repeat(40)}}, 'code from "https://example.invalid/repo" at commit ' + 'c'.repeat(40)],
  ['one file', {files:[{path:'a'}]}, '1 file ("a")'],
  ['multiple files', {files:[{path:'a'},{path:'b'}]}, '2 files ("a", "b")'],
  ['truncated files', {files:Array.from({length:6},(_,i)=>({path:String(i)}))}, '6 files ("0", "1", "2", "3", "4", …)'],
]) test(label + ': existing consent unchanged', () => assert.equal(confirm(input), 'Send ' + expected + suffix));
test('no source: existing consent unchanged', () => assert.equal(confirm({noSource:true}), "Send only the prompt (no files) to your selected circle for its lenders to run on another person's computer."));
