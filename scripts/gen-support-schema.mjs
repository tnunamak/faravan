import {readFile, writeFile} from 'node:fs/promises';
import {SUPPORT_SCHEMA} from '../lib/v1/diagnostics-schema.mjs';

const file = new URL('../docs/support/diagnostics.schema.json', import.meta.url);
const text = JSON.stringify(SUPPORT_SCHEMA, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8').catch(() => '') !== text) throw new Error('Run node scripts/gen-support-schema.mjs');
} else await writeFile(file, text);
