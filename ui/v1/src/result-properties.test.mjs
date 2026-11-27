import test from 'node:test';
import assert from 'node:assert/strict';
import {ResultProperties} from './result-properties.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const receipt={harness:'claude-code-subscription',duration_ms:37000,model:'Sonnet'};
test('result Properties use labelled values and own jobs say Your computer',()=>{
 const html=renderFixture(ResultProperties,{receipt,lender:'Kestrel',ownRun:true,retention:{retained_until:'2026-11-20T12:00:00Z'},zone:'UTC'});
 for(const label of ['Agent','Ran on','Time used','Kept until'])assert.ok(html.includes('<dt>'+label+'</dt>'));
 assert.match(renderedText(html),/Ran on Your computer/);assert.doesNotMatch(renderedText(html),/lender|synthetic-only/);
});
test('borrowed results name the runner and unknown properties are omitted by default',()=>{
 assert.match(renderedText(renderFixture(ResultProperties,{receipt,lender:'Kestrel'})),/Kestrel/);
 assert.doesNotMatch(renderedText(renderFixture(ResultProperties,{})),/Not recorded|Ran on|Time used|Agent|Kept until/);
});
test('unavailable and cancelled results omit unrecorded properties',()=>{
 const out=renderFixture(ResultProperties,{retention:{retained_until:'2026-11-20T12:00:00Z'}});
 assert.doesNotMatch(renderedText(out),/Not recorded|Agent|Time used|Ran on/);assert.match(renderedText(out),/Kept until/);
});

test('recorded computer names identify the run',()=>{
 assert.match(renderedText(renderFixture(ResultProperties,{receipt:{harness:'codex'},lender:'Tessa',device:'sandpiper'})),/Ran on sandpiper/);
});
