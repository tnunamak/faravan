#!/usr/bin/env node
// Regenerate what the operation registry publishes: docs/protocol/app-openapi.json and the parity matrix in
// docs/design/AGENT-INTERFACES.md (between the GENERATED markers). `npm run gen:ops`; tests/v1-ops*.test.mjs fail if stale.
// --check exits 1 when either file is out of date, without writing.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OPS, SURFACE_NAME, offeredOnMcp } from '../lib/v1/ops/registry.mjs';
import { openApiDocument } from '../lib/v1/ops/http.mjs';

const root = new URL('../', import.meta.url);
const OPENAPI = new URL('docs/protocol/app-openapi.json', root), DESIGN = new URL('docs/design/AGENT-INTERFACES.md', root);
const START = '<!-- GENERATED:parity-matrix (npm run gen:ops) -->', END = '<!-- /GENERATED:parity-matrix -->';

/** Before = what existed before the registry; after = what it exposes now. */
export function parity() {
  return OPS.map(op => {
    const human = op.safety === 'human';
    return {id:op.id, title:op.title, safety:op.safety,
      ui:op.ui ?? [], before:{ui:Boolean(op.ui?.length), cli:op.cli?.legacy ?? null, http:op.rest ? op.rest.method + ' ' + op.rest.path : null, mcp:op.mcp?.legacy ?? null},
      after:{cli:human ? op.cli?.legacy ?? null : SURFACE_NAME.cli(op), http:human ? null : SURFACE_NAME.http(op), mcp:offeredOnMcp(op) ? SURFACE_NAME.mcp(op) : null}};
  });
}
export function matrixMarkdown() {
  const rows = parity();
  const count = pick => rows.filter(pick).length;
  const total = rows.length;
  const lines = [START, '',
    '| Surface | Before the registry | After |', '|---|---|---|',
    '| UI (web app or tray) | ' + count(r => r.before.ui) + ' of ' + total + ' | ' + count(r => r.before.ui) + ' of ' + total + ' (unchanged; the UI calls the bound routes) |',
    '| CLI | ' + count(r => r.before.cli) + ' of ' + total + ' | ' + count(r => r.after.cli) + ' of ' + total + ' |',
    '| HTTP | ' + count(r => r.before.http) + ' of ' + total + ' (REST routes) | ' + count(r => r.after.http) + ' of ' + total + ' (`POST /api/ops/<id>`; the ' + count(r => r.before.http) + ' REST routes still work) |',
    '| MCP | ' + count(r => r.before.mcp) + ' of ' + total + ' | ' + count(r => r.after.mcp) + ' of ' + total + ' |',
    '| All four | ' + count(r => r.before.ui && r.before.cli && r.before.http && r.before.mcp) + ' of ' + total + ' | ' +
      count(r => r.after.cli && r.after.http && r.after.mcp) + ' of ' + total + ' on CLI, HTTP and MCP (' + count(r => r.safety === 'human') + ' human-only: CLI only; ' +
        count(r => r.safety !== 'human' && !r.after.mcp) + ' excluded from MCP: CLI and HTTP) |', '',
    'Before: UI screen, CLI command, REST route and MCP tool that existed before the registry. After: generated names. A dash means none.', '',
    '| Operation | Safety | UI | CLI before | REST route (HTTP before) | MCP before | CLI | MCP tool |', '|---|---|---|---|---|---|---|---|'];
  const cell = value => value ? '`' + value + '`' : '-';
  for (const r of rows) lines.push('| `' + r.id + '` ' + r.title + ' | ' + r.safety + ' | ' + (r.ui.join(', ') || '-') + ' | ' + cell(r.before.cli) + ' | ' +
    cell(r.before.http) + ' | ' + cell(r.before.mcp) + ' | ' + cell(r.after.cli) + ' | ' + cell(r.after.mcp) + ' |');
  lines.push('', END);
  return lines.join('\n');
}
export async function generated() {
  const openapi = JSON.stringify(openApiDocument(), null, 2) + '\n';
  const design = await readFile(DESIGN, 'utf8');
  const start = design.indexOf(START), end = design.indexOf(END);
  if (start < 0 || end < 0) throw new Error('docs/design/AGENT-INTERFACES.md lacks the GENERATED markers');
  return {openapi, design:design.slice(0, start) + matrixMarkdown() + design.slice(end + END.length)};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await generated();
  const stale = [];
  if ((await readFile(OPENAPI, 'utf8').catch(() => '')) !== next.openapi) stale.push('docs/protocol/app-openapi.json');
  if ((await readFile(DESIGN, 'utf8')) !== next.design) stale.push('docs/design/AGENT-INTERFACES.md');
  if (process.argv.includes('--check')) {
    if (stale.length) { console.error('Out of date (run npm run gen:ops): ' + stale.join(', ')); process.exit(1); }
  } else {
    await writeFile(OPENAPI, next.openapi); await writeFile(DESIGN, next.design);
    console.log(stale.length ? 'Wrote ' + stale.join(', ') : 'Up to date.');
  }
}
