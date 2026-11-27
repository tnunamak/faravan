import test from 'node:test';
import assert from 'node:assert/strict';
import {ParentJobLink} from './job-parent.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const parent={job_digest:'sha256:'+'a'.repeat(64),result_digest:'sha256:'+'b'.repeat(64)};
test('lenders can open a signed parent link in the same circle with its provenance stated',()=>{
 const html=renderFixture(ParentJobLink,{parent:{...parent,title:'Fix the parser'},circle:'c'});assert.match(html,/href="#\/job\/sha256%3Aa+\/c"/);assert.match(renderedText(html),/Follow-up to Fix the parser/);assert.doesNotMatch(renderedText(html),/signed request/);
 assert.equal(renderFixture(ParentJobLink,{parent:{...parent,job_digest:'javascript:bad'},circle:'c'}),'');
});

test('a parent with an unresolved title has an explicit parent label',()=>{
 const html=renderFixture(ParentJobLink,{parent,circle:'c'});
 assert.match(renderedText(html),/Follow-up to the parent job…/);
 assert.doesNotMatch(renderedText(html),/earlier job/);
});
