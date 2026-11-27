import { readFile, writeFile } from 'node:fs/promises';

const begin = '<!-- STATUS TABLE BEGIN -->';
const end = '<!-- STATUS TABLE END -->';
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderTable(data) {
  const rows = data.map(row => {
  const evidence = row.evidence.length
    ? row.evidence.map(item => `\`${item.file}\`: “${item.title}”`).join('<br>')
    : 'No test';
  return `| ${escape(row.label)} | ${escape(row.state)} | ${escape(row.claim)} | ${evidence} |`;
  });
  return [begin, '| Part | State | Claim | Evidence (test titles) |', '|---|---|---|---|', ...rows, end].join('\n');
}

const dataUrl = new URL('../docs/internal/status.json', import.meta.url);
const statusUrl = new URL('../docs/internal/test-evidence.md', import.meta.url);
const data = JSON.parse(await readFile(dataUrl, 'utf8'));
const source = await readFile(statusUrl, 'utf8');
const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
if (!pattern.test(source)) throw new Error('test-evidence.md is missing the generated table markers');
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  await writeFile(statusUrl, source.replace(pattern, renderTable(data)));
}
