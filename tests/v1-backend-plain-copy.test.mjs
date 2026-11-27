import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const banned=/\b(?:verdicts?|receipts?|attempt(?:s|ed|ing)?|settled|leases?|\x73parekin)\b|Ran on|—/i;
const source=path=>readFile(new URL('../lib/v1/'+path,import.meta.url),'utf8');

test('operation titles and descriptions use plain words without renaming wire fields',async()=>{
 const registry=await source('ops/registry.mjs');
 const copy=[...registry.matchAll(/\b(?:title|description)\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map(match=>match[2]);
 assert.ok(copy.length>100,'checks the whole declared operation copy surface');
 for(const text of copy)assert.doesNotMatch(text,banned);
 assert.match(registry,/op\('jobs\.receipt'/);
 assert.match(registry,/receipt:\{type:'object'\}/);
 assert.match(registry,/verdict:S\.enum/);
 assert.match(registry,/settled:S\.bool\(\)/);
});

test('ChatGPT permissions and lending recovery display copy use saved results and runs',async()=>{
 const page=await source('chatgpt-page.mjs');
 const permissions=[...page.matchAll(/<li>([^<]*)<\/li>/g)].map(match=>match[1]);
 assert.ok(permissions.length>5);
 for(const text of permissions)assert.doesNotMatch(text,banned);
 assert.ok(permissions.includes('Job status, changes and saved results.'));
 const lending=await source('lending-log.mjs');
 const recovery=lending.match(/row\.attemptId\?\?'([^']+)'/);
 assert.ok(recovery);
 assert.equal(recovery[1],'an unknown run');
 assert.doesNotMatch(recovery[1],banned);
});

test('ChatGPT overview renders plain connection and activity copy and human labels',async()=>{
 const {chatgptPage}=await import('../lib/v1/chatgpt-page.mjs');
 const html=chatgptPage({status:{connections:[{id:'c1',client:'Client',scope:'read',redirect_host:'chatgpt.com',registered_at:1}],audit:[
  {at:1,client_id:'c1',client:'Client',op:'jobs.read',outcome:'completed',effect:'Saved a result'},
 ]}});
 assert.match(html,/<strong>Client<\/strong> has access to read, returns to <code>chatgpt\.com/);
 assert.match(html,/completed jobs\.read; effect: Saved a result at/);
 const action=chatgptPage({action:{id:'a1',label:'review a change',what:'Review',details:{input:{outcome:{verdict:'used'}}},status:'waiting'}});
 assert.match(action,/<dt>Assessment<\/dt><dd>used<\/dd>/);
 assert.doesNotMatch(action,/<dt>Verdict<\/dt>/);
 const visible=(html+action).replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
 assert.doesNotMatch(visible,banned);
});
