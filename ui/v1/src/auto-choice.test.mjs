import test from 'node:test';
import assert from 'node:assert/strict';
import {autoOffered, keepAuto, choiceOffered} from './compose-model.mjs';
import {loadDraft, draftBody, COMPOSE_DRAFT_PREFIX} from './compose-draft.mjs';
import {composeVM} from './view-models.mjs';

// A lender says which automatic choices it can make (offer.auto_intents). The screen reads that list and never works out
// a rank or a price itself.
const offer = (model, effort, auto_intents) => ({harness:'codex', model, effort, ...(auto_intents ? {auto_intents} : {})});
const BOTH = ['cheapest', 'strongest'];

test('each preset is offered only where some lender says it can make that choice', () => {
  const offers = [offer('gpt-6-luna', 'low', BOTH), offer('gpt-5.4-mini', 'low', ['cheapest']), offer('mystery', 'low')];
  assert.equal(autoOffered(offers, 'codex', 'cheapest'), true);
  assert.equal(autoOffered(offers, 'codex', 'strongest'), true);
  const cheapOnly = [offer('gpt-5.4-mini', 'low', ['cheapest'])];
  assert.equal(autoOffered(cheapOnly, 'codex', 'cheapest'), true);
  assert.equal(autoOffered(cheapOnly, 'codex', 'strongest'), false, 'a model with no rank cannot be the strongest');
  const none = [offer('mystery', 'low')];
  for (const intent of BOTH) assert.equal(autoOffered(none, 'codex', intent), false);
  assert.equal(autoOffered(cheapOnly, 'claude-code', 'cheapest'), false, 'another agent');
  assert.equal(autoOffered(cheapOnly, 'codex', 'best'), false, 'a choice nobody defined');
});

test('a preset is kept and allowed to send only while its own support remains', () => {
  const cheapOnly = [offer('gpt-5.4-mini', 'low', ['cheapest'])];
  assert.equal(keepAuto(cheapOnly, {agent:'codex', auto:'cheapest'}), 'cheapest');
  assert.equal(keepAuto(cheapOnly, {agent:'codex', auto:'strongest'}), '');
  assert.equal(choiceOffered(cheapOnly, {agent:'codex', auto:'cheapest'}), true);
  assert.equal(choiceOffered(cheapOnly, {agent:'codex', auto:'strongest'}), false);
});

test('a choice this screen does not know is an invalid choice, never a blank one', () => {
  const offers = [offer('gpt-6-luna', 'low', BOTH)];
  assert.equal(choiceOffered(offers, {agent:'codex', auto:'best'}), false, 'offered models do not make an unknown choice valid');
  assert.equal(keepAuto(offers, {agent:'codex', auto:'best'}), 'best', 'the saved value stays visible until the person changes it');
});

const store = saved => { const map = new Map(Object.entries(saved)); return {getItem:key => map.get(key) ?? null, setItem:(key, value) => map.set(key, value), removeItem:key => map.delete(key)}; };
const saved = auto => ({id:'draft-unknown-1', prompt:'Summarise the plan', sourceKind:'none', agent:'codex', auto});

test('a restored draft keeps an unknown choice and refuses to build a request from it', () => {
  const storage = store({[COMPOSE_DRAFT_PREFIX + 'c']: JSON.stringify(saved('best'))});
  const draft = loadDraft(storage, 'c');
  assert.equal(draft.auto, 'best');
  assert.equal(draft.prompt, 'Summarise the plan', 'the rest of the draft is restored');
  assert.throws(() => draftBody(draft, 'c'), /automatic choice/i);
  assert.deepEqual(draftBody({...draft, auto:'strongest'}, 'c').auto_run_v1, {intent:'strongest'});
  assert.equal(draftBody({...draft, auto:''}, 'c').auto_run_v1, undefined, 'clearing the choice is how a person sends the lender default');
  assert.equal(loadDraft(store({}), 'c').auto, '');
});

test('the composer says which choice it does not know and keeps Send off until it is changed', () => {
  const state = {networked:true, host:{label:'Host', reachable:true}, lenders:[], offers:[offer('gpt-6-luna', 'low', BOTH)]};
  const vmFor = choice => composeVM({prompt:'Do it', sourceKind:'none', repo:{status:'ok'}, draftSaved:true, circle:{id:'c', name:'Friends', state}, choice});
  const unknown = vmFor({agent:'codex', auto:'best'});
  assert.equal(unknown.send.disabled, true);
  assert.match(unknown.send.why, /“best”/);
  assert.match(unknown.send.why, /Cheapest that fits|Strongest offered/);
  assert.equal(vmFor({agent:'codex', auto:'strongest'}).send.disabled, false);
  assert.equal(vmFor({agent:'codex', auto:''}).send.disabled, false);
  const unsupported = composeVM({prompt:'Do it', sourceKind:'none', repo:{status:'ok'}, draftSaved:true,
    circle:{id:'c', name:'Friends', state:{...state, offers:[offer('gpt-5.4-mini', 'low', ['cheapest'])]}}, choice:{agent:'codex', auto:'strongest'}});
  assert.equal(unsupported.send.disabled, true);
  assert.match(unsupported.send.why, /Strongest offered/);
});
