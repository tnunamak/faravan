import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderTable } from '../scripts/status-table.mjs';

test('status table matches its data and every cited title exists', async () => {
  const status = await readFile(new URL('../docs/internal/test-evidence.md', import.meta.url), 'utf8');
  const rows = JSON.parse(await readFile(new URL('../docs/internal/status.json', import.meta.url), 'utf8'));
  const begin = '<!-- STATUS TABLE BEGIN -->';
  const end = '<!-- STATUS TABLE END -->';
  const start = status.indexOf(begin);
  const finish = status.indexOf(end, start);
  assert.notEqual(start, -1, 'begin marker exists');
  assert.notEqual(finish, -1, 'end marker exists');
  const actualTable = status.slice(start, finish + end.length);
  assert.equal(actualTable, renderTable(rows), 'generated table is current');
  for (const row of rows) for (const evidence of row.evidence) {
    const source = await readFile(new URL(`../${evidence.file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(evidence.title), `${evidence.file} contains test title: ${evidence.title}`);
  }
});
