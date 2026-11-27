import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeSessionLog } from '../lib/v1/lending-history-import.mjs';

const row = (output, timestamp, change = {}) => ({type:'assistant', timestamp, message:{
  id:'streamed', model:'claude-sonnet-4-5', usage:{input_tokens:12, output_tokens:output,
    cache_read_input_tokens:30, cache_creation_input_tokens:10,
    cache_creation:{ephemeral_5m_input_tokens:6, ephemeral_1h_input_tokens:4}, ...change},
}});
const parse = rows => parseClaudeSessionLog(rows.map(value => JSON.stringify(value)).join('\n'));
const times = ['2026-10-01T12:00:00Z', '2026-10-01T12:00:01Z', '2026-10-01T12:00:02Z'];

test('streamed blocks import once with largest output and earliest timestamp', () => {
  const result = parse([row(1,times[0]), row(5,times[1]), row(9,times[2])]);
  assert.equal(result.malformedLines,0);
  assert.equal(result.usage.length,1);
  assert.equal(result.usage[0].tokens.output,9);
  assert.equal(result.usage[0].at,Date.parse(times[0]));
  assert.deepEqual(result.usage[0].tokens,{fresh_input:12,cache_read:30,cache_write_5m:6,
    cache_write_1h:4,output:9,reasoning:0});
});

test('out-of-order timestamps and lower output do not erase maximum output', () => {
  const result = parse([row(9,times[2]),row(9,times[1]),row(2,times[0])]);
  assert.equal(result.malformedLines,0);
  assert.equal(result.usage.length,1);
  assert.equal(result.usage[0].tokens.output,9);
  assert.equal(result.usage[0].at,Date.parse(times[0]));
});

test('unknown timestamps do not hide an observed earliest timestamp', () => {
  const result = parse([row(1,undefined),row(9,times[1]),row(9,undefined)]);
  assert.equal(result.malformedLines,0);
  assert.equal(result.usage.length,1);
  assert.equal(result.usage[0].at,Date.parse(times[1]));
  assert.equal(result.usage[0].tokens.output,9);
});

test('different input count remains a sticky conflict', () => {
  const result = parse([row(1,times[0]),row(9,times[1],{input_tokens:13}),row(10,times[2])]);
  assert.equal(result.usage.length,0);
  assert.equal(result.malformedLines,1);
});

for (const [name,change] of [
  ['cache read',{cache_read_input_tokens:31}],
  ['cache total',{cache_creation_input_tokens:11,cache_creation:{ephemeral_5m_input_tokens:7,ephemeral_1h_input_tokens:4}}],
  ['cache lifetime split',{cache_creation:{ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:5}}],
]) test(`${name} differences still conflict`, () => {
  const result = parse([row(1,times[0]),row(9,times[1],change)]);
  assert.equal(result.usage.length,0);
  assert.equal(result.malformedLines,1);
});

test('different model still conflicts', () => {
  const changed=row(9,times[1]); changed.message.model='claude-opus-4-1';
  assert.deepEqual(parse([row(1,times[0]),changed]),{usage:[],malformedLines:1});
});

test('single-line usage remains unchanged', () => {
  assert.deepEqual(parse([row(9,times[0])]),{malformedLines:0,usage:[{
    account:'claude',provider:'claude',at:Date.parse(times[0]),message_id:'streamed',model:'claude-sonnet-4-5',
    tokens:{fresh_input:12,cache_read:30,cache_write_5m:6,cache_write_1h:4,output:9,reasoning:0},
  }]});
});
