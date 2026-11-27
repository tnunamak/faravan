import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposeBody} from './compose.jsx';
import {composeVM} from './view-models.mjs';
import {draftBody, saveDraft, loadDraft} from './compose-draft.mjs';
import * as composeModel from './compose-model.mjs';
import {renderFixture} from './render.test-helper.mjs';

// Model and Effort: the composer offers only the pairs a lender offers now, and sends exactly the pair chosen.
const NOW = Date.parse('2026-11-01T09:00:00Z');
const info = {path:'/home/sam/code/booking-site', name:'booking-site', branch:'main', head:'8d01e4a' + 'b'.repeat(33), files:212, changed:[], changed_count:0};
const offers = [
  {harness:'codex', model:'example-model', effort:'low'},
  {harness:'codex', model:'example-model', effort:'high'},
  {harness:'codex', model:'other-model', effort:'medium'},
  {harness:'claude-code', model:'claude-opus-5-5', effort:'medium'},
];
const circle = {id:'c1', name:'Weekend projects', state:{networked:true, host:{label:'Ana’s MacBook', reachable:true}, lenders:[], offers}};
const draft = (over = {}) => ({id:'draft-0001-aaaa', prompt:'Reject a checkout before check-in.', path:info.path, includeUncommitted:false, agent:'', model:'', effort:'', sending:false, ...over});
const vmFor = choice => composeVM({prompt:'Reject a checkout before check-in.', repo:{status:'ok', info}, circle, choice, draftSaved:true, now:NOW, zone:'UTC'});
const page = (vm, d) => renderFixture(ComposeBody, {vm, project:info, draft:d, circles:[], circle:'c1', agents:[{id:'codex'}, {id:'claude-code'}], offers,
  onPrompt() {}, onPath() {}, onInclude() {}, onAgent() {}, onModel() {}, onEffort() {}, onCircle() {}, onCheck() {}, onSend() {}, onCancel() {}});
const select = (out, id) => out.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))[0];

test('the default choices send the same body as before and both selects start on Let the lender choose', () => {
  const d = draft({agent:'codex'});
  assert.equal(JSON.stringify(draftBody(d, 'c1')),
    '{"circle":"c1","prompt":"Reject a checkout before check-in.","draft_id":"draft-0001-aaaa","repo":{"path":"/home/sam/code/booking-site"},"harness":"codex"}');
  const vm = vmFor({agent:'codex', model:'', effort:''}), out = page(vm, d);
  assert.equal(vm.send.disabled, false);
  const model = select(out, 'cmp-model'), effort = select(out, 'cmp-effort');
  // The renderer writes an empty value as a bare `value` attribute, which the browser reads as value="".
  assert.match(model, /<option selected value(?:="")?>Let the lender choose<\/option>/);
  assert.match(model, /<option value="example-model">example-model<\/option>/);
  assert.match(effort, /<option selected value(?:="")?>Let the lender choose<\/option>/);
  assert.doesNotMatch(model, /disabled/);
  assert.match(out, /Model · Set by the lender/);
});

test('the body Send posts carries the chosen pair in the fields the job submit takes', () => {
  const body = draftBody(draft({agent:'codex', model:'example-model', effort:'low'}), 'c1');
  assert.deepEqual({harness:body.harness, model:body.model, budget_v1:body.budget_v1},
    {harness:'codex', model:'example-model', budget_v1:{effort:'low'}});
  assert.equal(draftBody(draft({agent:'', model:'example-model', effort:'low'}), 'c1').model, undefined, 'a pair belongs to one agent');
});

test('a chosen pair no lender offers blocks Send and names it; a model without an effort blocks Send until one is chosen', () => {
  const vm = vmFor({agent:'codex', model:'other-model', effort:'low'});
  assert.equal(vm.send.disabled, true);
  assert.equal(vm.send.why, 'No lender offers other-model at low right now');
  assert.equal(vmFor({agent:'codex', model:'claude-opus-5-5'}).send.why, 'No lender offers claude-opus-5-5 right now');
  // A model is never sent alone: a lender that offers it only at other efforts would skip it, so the composer asks for an effort.
  assert.equal(vmFor({agent:'codex', model:'other-model'}).send.disabled, true, 'a model offered at some effort still waits for an effort');
  assert.equal(vmFor({agent:'codex', model:'other-model'}).send.why, 'Choose an effort for other-model');
  assert.equal(vmFor({agent:'claude-code', effort:'low'}).send.why, 'No lender offers low effort right now');
  assert.equal(vmFor({agent:'codex', model:'example-model', effort:'high'}).send.disabled, false, 'an offered pair can be sent');
  assert.equal(vmFor({agent:'', model:'', effort:''}).send.disabled, false, 'the default can be sent');
});

test('Model and Effort list only the pairs offered for the chosen agent, and keep a choice only while it is offered', () => {
  assert.deepEqual(composeModel.offeredModels(offers, 'codex'), ['example-model', 'other-model']);
  assert.deepEqual(composeModel.offeredModels(offers, 'claude-code'), ['claude-opus-5-5']);
  assert.deepEqual(composeModel.offeredEfforts(offers, 'codex', 'example-model'), ['low', 'high']);
  assert.deepEqual(composeModel.offeredEfforts(offers, 'codex'), ['low', 'high', 'medium']);
  assert.deepEqual(composeModel.keepOffered(offers, {agent:'codex', model:'example-model', effort:'high'}), {model:'example-model', effort:'high'});
  assert.deepEqual(composeModel.keepOffered(offers, {agent:'codex', model:'other-model', effort:'low'}), {model:'other-model', effort:''});
  assert.deepEqual(composeModel.keepOffered(offers, {agent:'claude-code', model:'example-model', effort:'high'}), {model:'', effort:''});
});

test('Model and Effort stay off until an agent is chosen, and a choice no lender offers stays visible with its reason', () => {
  const none = page(vmFor({}), draft({agent:''}));
  assert.match(select(none, 'cmp-model'), /disabled/);
  assert.match(select(none, 'cmp-effort'), /disabled/);
  const retained = draft({agent:'codex', model:'gone-model', effort:'low'});
  const out = page(vmFor({agent:'codex', model:'gone-model', effort:'low'}), retained);
  assert.match(select(out, 'cmp-model'), /<option selected value="gone-model">gone-model<\/option>/);
  assert.match(out, /No lender offers gone-model at low right now/);
});

test('a draft keeps its Model and Effort choice across a reload', () => {
  const cells = new Map();
  const storage = {getItem: key => cells.get(key) ?? null, setItem: (key, value) => void cells.set(key, String(value)), removeItem: key => void cells.delete(key)};
  saveDraft(storage, 'c1', draft({agent:'codex', model:'example-model', effort:'low'}));
  const back = loadDraft(storage, 'c1');
  assert.deepEqual([back.agent, back.model, back.effort], ['codex', 'example-model', 'low']);
  assert.deepEqual([loadDraft(storage, 'other').model, loadDraft(storage, 'other').effort], ['', '']);
});

test('the Effort select asks for an effort once a model is chosen, and its help text is linked to the select', () => {
  const d = draft({agent:'codex', model:'other-model'});
  const out = page(vmFor({agent:'codex', model:'other-model'}), d), effort = select(out, 'cmp-effort');
  assert.match(effort, /<option selected value(?:="")?>Choose an effort<\/option>/);
  assert.match(effort, /aria-describedby="cmp-effort-help"/);
  assert.match(out, /id="cmp-effort-help"[^>]*>Choosing a model means you also choose the effort\. How hard the agent thinks\. More effort uses more of the lender’s allowance\.<\/p>/);
});

test('the composer promises no availability it cannot confirm, and says lender settings are a snapshot', () => {
  const out = page(vmFor({}), draft({agent:'codex'}));
  assert.doesNotMatch(out, /host confirms availability|Availability is confirmed/);
  assert.match(out, /Choices reflect recently reported lender settings\. Availability can change before a lender picks up your request\./);
});

// Item 1 (1102 review): with both choices on the lender, Model and Effort stay behind a closed summary, not two open selects.
test('Model and Effort sit behind a disclosure that stays closed while the lender chooses both', () => {
  const d = draft({agent:'codex'});
  const out = page(vmFor({agent:'codex', model:'', effort:''}), d);
  assert.match(out, /<details class="cmp-model-choice">\s*<summary[^>]*>[\s\S]*?Lender’s choice: example-model · low effort<\/span>[\s\S]*?<\/summary>/);
  assert.match(out, /<details class="cmp-model-choice">[\s\S]*?id="cmp-model"[\s\S]*?<\/details>/);
  assert.match(out, /<details class="cmp-model-choice">[\s\S]*?id="cmp-effort"[\s\S]*?<\/details>/);
  const chosen = page(vmFor({agent:'codex', model:'example-model', effort:'high'}), draft({agent:'codex', model:'example-model', effort:'high'}));
  assert.match(chosen, /<details class="cmp-model-choice" open>/);
  assert.match(chosen, /<span class="cmp-setting-value">example-model · high effort<\/span>/);
});

test('a blank Model and Effort says what the first offer of the chosen agent will run', () => {
  const d = draft({agent:'codex'});
  assert.match(page(vmFor({agent:'codex', model:'', effort:''}), d), /Lender’s choice: example-model · low effort/);
  assert.match(page(vmFor({agent:'claude-code', model:'', effort:''}), draft({agent:'claude-code'})), /Lender’s choice: claude-opus-5-5 · medium effort/);
  // A chosen model or no offer for the agent keeps today's text.
  assert.doesNotMatch(page(vmFor({agent:'codex', model:'other-model', effort:'medium'}), draft({agent:'codex', model:'other-model', effort:'medium'})), /Lender’s choice/);
  assert.match(page(vmFor({agent:'gemini', model:'', effort:''}), draft({agent:'gemini'})), /Let the lender choose/);
  assert.equal(composeModel.lendersChoice(offers, 'gemini'), '');
});

test('the signed Model row says which model and effort "Any" will run', () => {
  const accountOffers = [{providerId:'claude', modelId:'claude-sonnet-5-5', effortIds:['low','medium','high']}, {providerId:'claude', modelId:'claude-opus-5-5', effortIds:['low','medium','high']}];
  const out = renderFixture(ComposeBody, {vm:vmFor({agent:'', model:'', effort:''}), project:info, draft:draft(), circles:[], circle:'c1', agents:[], offers:[], signed:true, accountOffers,
    runRequest:{schemaVersion:1, models:'any', effortId:null}, onPrompt() {}, onPath() {}, onInclude() {}, onAgent() {}, onCircle() {}, onCheck() {}, onSend() {}, onCancel() {}});
  assert.match(out, /Lender’s choice: claude-sonnet-5-5 · medium effort/);
  assert.equal(composeModel.lendersAccountChoice([]), '');
  // Medium is the default only when offered; otherwise the line names the model alone and never another effort.
  assert.equal(composeModel.lendersAccountChoice([{providerId:'p', modelId:'m', effortIds:['low','high']}]), 'Lender’s choice: m');
});
