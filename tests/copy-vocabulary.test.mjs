import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {RETIRED_FORMS} from '../ui/v1/src/concepts.mjs';

// S0.1b / DESIGN-SYSTEM section 5; EXPERIENCE sections 1.9, 6.6 and 7.1.
// Scan production Go files recursively; fixtures may contain banned copy.
function traySources(path = 'tray/internal') {
  return readdirSync(new URL('../' + path + '/', import.meta.url), {withFileTypes: true})
    .flatMap(entry => entry.isDirectory() ? traySources(path + '/' + entry.name) :
      entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')
        ? [path + '/' + entry.name] : []);
}
const paths = [
  ...traySources(),
  "ui/v1/src/view-models.mjs",
  "ui/v1/src/safety-copy.mjs",
  "ui/v1/src/helpers.mjs",
  "ui/v1/src/main.jsx",
  "ui/v1/src/home.jsx",
  "ui/v1/src/jobs.jsx",
  "ui/v1/src/job-view.jsx",
  "ui/v1/src/apply-sheet.jsx",
  "ui/v1/src/lend.jsx",
  "ui/v1/src/compose.jsx",
  "ui/v1/src/request.jsx",
  "ui/v1/src/setup.jsx",
  "ui/v1/src/circles.jsx",
  "ui/v1/src/shared.jsx",
  "ui/v1/src/local-name.jsx",
  "ui/v1/src/info.jsx",
  "ui/v1/src/signin.jsx",
  "public/join/index.html",
  "lib/v1/cli.mjs",
  "lib/v1/run.mjs",
  "lib/v1/status.mjs",
  "lib/v1/help.mjs",
  "lib/disk-report.mjs"
];

const vocabulary = [
  ['Member \\d', /(?:\bmember\s+(?:\d+|\$\{[^}]+\})|^member$)/gi],
  ...['key id', 'fingerprint', 'verdict', 'receipt', 'harness', 'roster',
    'lease', 'claim', 'attempt', 'settled', 'coordinator', 'collective',
    'execution_failed', 'faravan doctor', 'Check setup', 'UNVERIFIED',
    'Any available model', 'sealed', 'can reach only', 'only for this job',
    'stays outside the sandbox', 'Ran on', 'Merge into main'].map(word => [word, new RegExp('\\b' + word + '\\b', 'gi')]),
  // Retired forms come from the concept registry (ui/v1/src/concepts.mjs), so retiring a word is one edit there.
  ...RETIRED_FORMS,
];

// Inspect literal text, never evaluate or import product code. Keep comments and
// identifiers out of the scan; include JSX/HTML text and multiline templates.
// Conservatively include technical string literals too, since these can become
// output through a lookup. Grandfather them explicitly, never exempt identifiers
// or whole files. Security-only fingerprint copy can have an exact allowance.
function closesJsxTag(source, at) {
  const start = source.lastIndexOf('<', at);
  if (start < 0 || !/^\/?(?:[A-Za-z][\w:.-]*\b|$)/.test(source.slice(start + 1, at))) return false;
  let depth = 0, quote = null;
  for (let i = start + 1; i <= at; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
    } else if ('"\'`'.includes(char)) quote = char;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0) return i === at;
  }
  return false;
}
function fragments(source, path) {
  const parts = [];
  const token = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|(?<!=)>([^<>{}]+)(?=[<{])/g;
  const pattern = /\.(mjs|go)$/.test(path) ? new RegExp(token.source.split('|(?<!=)>')[0], 'g') : token;
  for (const match of source.matchAll(pattern)) {
    const raw = match[0];
    if (/^(?:\/\/|\/\*|<!--)/.test(raw)) continue;
    if (raw.startsWith('>') && /\.(mjs|go)$/.test(path)) continue;
    if (raw.startsWith('>') && !closesJsxTag(source, match.index)) continue;
    const quoted = /^["'`]/.test(raw);
    let text = quoted ? raw.slice(1, -1) : raw.slice(1);
    text = text.replace(/\\n|\\r|\\t/g, ' ').replace(/\\(["'`\\])/g, '$1')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;

    parts.push({text, line: source.slice(0, match.index).split('\n').length});
  }
  return parts;
}

function scan(source, path) {
  const hits = [];
  for (const fragment of fragments(source, path)) {
    for (const [word, pattern] of vocabulary) {
      if (word === 'faravan doctor' && !path.startsWith('ui/v1/')) continue;
      for (const match of fragment.text.matchAll(pattern)) {
        hits.push({path, word, text: fragment.text, line: fragment.line});
      }
    }
  }
  return hits;
}
// Safety copy belongs exclusively to the facts-driven view model (BUILD-PLAN rule 2).
// Match fragments too, including interpolated names; not technical field names.
const safetySentences = [
  /\bsign-in (?:may be reachable|stays outside)\b/i,
  /\b(?:can|cannot|can't) reach (?:only |your home network|public websites|the internet|[A-Z])/i,
  /\b(?:runs?|ran) .{0,80}\b(?:fresh|sealed) sandbox\b/i,
  /\b(?:only the files sent|only for this job|no other websites)\b/i,
  /\b(?:these protections|not yet independently tested|independently verified)\b/i,
  /\b(?:network use was not reported|the job can still use your allowance)\b/i,
  /\bsay yes only to people you trust\b/i,
];
function safetyHits(source, path) {
  if (['ui/v1/src/view-models.mjs', 'ui/v1/src/safety-copy.mjs'].includes(path)) return [];
  return fragments(source, path).filter(({text}) => safetySentences.some(re => re.test(text)))
    .map(fragment => ({...fragment, path, word: 'safety sentence outside view-models.mjs'}));
}
function key(hit) { return JSON.stringify([hit.path, hit.word, hit.text]); }
function unexpected(hits, allowed) {
  const remaining = new Map(allowed);
  return hits.filter(hit => {
    const id = key(hit), count = remaining.get(id) || 0;
    if (count) { remaining.set(id, count - 1); return false; }
    return true;
  });
}

// Frozen current debt at 07a69a1112f6f0d5cfa1b94cb8cc5a379aab6b47.
// Exact file + term + normalized literal + occurrence count, not a file-wide
// exception. Each U slice removes its entries when it replaces that copy.
const baseline = [
  ["ui/v1/src/helpers.mjs", "Any available model", "Any available model", 1],
  ["ui/v1/src/helpers.mjs", "Member \\d", "member", 1],
  ["ui/v1/src/helpers.mjs", "UNVERIFIED", "Unverified request", 1],
  ["ui/v1/src/view-models.mjs", "execution_failed", "execution_failed", 1],
  ["tray/internal/faravantray/notify.go", "harness", "json:\"harness\"", 1],
  ["public/join/index.html", "coordinator", "coordinator", 1],
  ["public/join/index.html", "UNVERIFIED", "(unverified).", 2],
  ["lib/v1/cli.mjs", "execution_failed", "execution_failed", 1],
  ["lib/v1/cli.mjs", "attempt", "Conflicting attempt identity", 1],
  ["lib/v1/cli.mjs", "harness", "harness", 1],
  ["lib/v1/run.mjs", "harness", "harness", 1],
  ["lib/v1/help.mjs", "harness", "--harness NAME", 2],
  // Retired forms (concepts.mjs) still in files other lanes own; each owner removes its row with the copy.
];
// Approved v4 copy from the shared safety/receipt helpers, distinct from frozen debt.
const approvedCopy = [
  // §M11 explicitly requires “Ran on” for the adapter/model/backend receipt fact.
  ["ui/v1/src/safety-copy.mjs", "Ran on", "${viewer==='own'?'Ran on this computer':viewer==='lender'?'Ran here':'Ran on '+where} with ${agent}${version ? ' ' + version : ''}${detail ?", 2],
  // Lead-approved composer label; this one exact screen-local use overrides the retired generic question.
  ["ui/v1/src/compose.jsx", "What should the agent do?", "What should the agent do?", 1],
];
const allowed = [...baseline, ...approvedCopy].map(([path, word, text, count]) => [key({path, word, text}), count]);
const sources = new Map(paths.map(path => [path, readFileSync(new URL('../' + path, import.meta.url), 'utf8')]));
// Request field names that are never printed, exempt at their exact source line, not by count: 385d9e27f (#478)
// added the `harness` job-input key and the `--harness` flag. Any other "harness" literal, in these files too, is copy.
const fieldNameSites = [
  ['lib/v1/cli.mjs', 'harness', "...Object.fromEntries(['circle','harness','model','egress','budget_v1','auto_run_v1','result'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),"],
  ['lib/v1/run.mjs', 'harness', "const {flags,position}=parse(argv,['source','prompt-file','circle','model','effort','harness','branch','timeout'],['include-uncommitted','yes']);"],
  ['lib/v1/run.mjs', 'harness', "...Object.fromEntries(['circle','model','harness'].filter(k=>flags[k]!==undefined).map(k=>[k,flags[k]])),"],
];
// Each site exempts one bare field-name hit on its own line; a copy of that line elsewhere is still a hit.
function withoutFieldNames(hits, sourceOf) {
  const used = new Set();
  const kept = hits.filter(hit => {
    const line = sourceOf(hit.path).split('\n')[hit.line - 1]?.trim();
    const site = fieldNameSites.findIndex(([path, word, text], n) =>
      !used.has(n) && path === hit.path && word === hit.word && hit.text === word && text === line);
    if (site < 0) return true;
    used.add(site);
    return false;
  });
  return {kept, unused: fieldNameSites.filter((_, n) => !used.has(n))};
}
const {kept: current, unused: unusedFieldNameSites} = withoutFieldNames(
  [...sources].flatMap(([path, source]) => scan(source, path)), path => sources.get(path));
function assertNoNew(hits, allowances = allowed) {
  const added = unexpected(hits, allowances);
  assert.equal(added.length, 0, 'New banned copy (replace it using the design docs):\n' +
    added.map(hit => hit.path + ':' + hit.line + ' [' + hit.word + '] ' + hit.text).join('\n'));
}

test('copy vocabulary: current product copy has no new banned hits', () => {
  assertNoNew(current);
  assert.deepEqual(unusedFieldNameSites, [], 'Remove obsolete field-name site');
  const counts = new Map();
  for (const hit of current) counts.set(key(hit), (counts.get(key(hit)) || 0) + 1);
  for (const [id, count] of allowed) {
    assert.equal(counts.get(id), count, 'Remove obsolete copy allowance: ' + id);
  }
});

test('copy vocabulary: a field-name site exempts only its own line, never printed copy in the same file', () => {
  for (const path of ['lib/v1/cli.mjs', 'lib/v1/run.mjs']) {
    const exempt = fieldNameSites.find(([site]) => site === path)[2];
    for (const added of ['console.log("Choose a harness");', "const extra = ['harness'];", exempt]) {
      const source = sources.get(path) + '\n' + added + '\n';
      const changed = current.filter(hit => hit.path !== path)
        .concat(withoutFieldNames(scan(source, path), () => source).kept);
      assert.throws(() => assertNoNew(changed), /\[harness\]/, path + ' + ' + added);
    }
  }
});

test('copy vocabulary: adding Member 2 fails the real guard without editing files', () => {
  const path = 'ui/v1/src/main.jsx';
  const changed = current.filter(hit => hit.path !== path)
    .concat(scan(sources.get(path) + '\nconst fixture = "Member 2";\n', path));
  assert.throws(() => assertNoNew(changed), /Member 2/);
  assert.throws(() => assertNoNew(scan('<p>Member 2</p>', path), []), /Member 2/);
});

test('copy vocabulary distinguishes comparisons from JSX text, including callback attributes', () => {
  assert.deepEqual(scan('const enough = budget > 0; const agent = card.harness; return <p>Ready</p>;', 'ui/v1/src/home.jsx'), []);
  assert.ok(scan('<button onClick={() => run()}>Choose a harness</button>', 'ui/v1/src/home.jsx').some(hit => hit.word === 'harness'));
  assert.ok(scan('<>Choose a harness</>', 'ui/v1/src/home.jsx').some(hit => hit.word === 'harness'));
});

test('copy vocabulary: every banned term is detected in UI and CLI literals', () => {
  for (const [word] of vocabulary) {
    const text = word === 'Member \\d' ? 'Member 2' : word;
    assert.ok(scan(JSON.stringify(text), 'ui/v1/src/helpers.mjs').length, text);
    if (word !== 'faravan doctor')
      assert.ok(scan('console.log(' + JSON.stringify(text) + ')', 'lib/v1/cli.mjs').length, text);
  }
});

test('copy vocabulary: the job page cannot reintroduce a verdict panel', () => {
  for (const path of ['ui/v1/src/jobs.jsx', 'ui/v1/src/job-view.jsx']) {
    assert.throws(() => assertNoNew(scan('<h2>Your verdict</h2>', path)), /verdict/i);
  }
});

test('copy vocabulary: duplicate, moved and changed debt cannot reuse an allowance', () => {
  const hit = scan('"View receipt"', 'ui/v1/src/helpers.mjs')[0];
  const one = [[key(hit), 1]];
  assertNoNew([hit], one);
  assert.throws(() => assertNoNew([hit, hit], one), /View receipt/);
  assert.throws(() => assertNoNew([{...hit, path: 'ui/v1/src/main.jsx'}], one), /View receipt/);
  assert.throws(() => assertNoNew(scan('"New receipt"', hit.path), one), /New receipt/);
});

test('copy vocabulary: retired forms come from the concept registry; a whole-word form spares longer sentences', () => {
  for (const [word] of RETIRED_FORMS) assert.ok(vocabulary.some(([w]) => w === word), word);
  const path = 'ui/v1/src/helpers.mjs';
  assert.ok(scan('"Unnamed device"', path).length);
  assert.ok(scan('"Someone"', path).length);
  assert.equal(scan('"Someone else’s code"', path).length, 0);
  assert.ok(scan('"The job stops now."', path).length);
});

test('copy vocabulary: comments and identifiers are not copy', () => {
  assert.deepEqual(scan('// Member 2\n/* receipt */\nconst fingerprint = coordinator;',
    'ui/v1/src/helpers.mjs'), []);
  assert.deepEqual(scan('<p>Membership is ready.</p><!-- Member 2 -->', 'public/join/index.html'), []);
  assert.deepEqual(scan('"disclaimer reclaim release"', 'lib/v1/cli.mjs'), []);
});

test('copy vocabulary: JSX apostrophes, templates, relative lines and whitespace', () => {
  const path = 'ui/v1/src/main.jsx';
  assert.equal(scan("<p>Someone else's code; read it.</p><p>Member 2</p>", path)[0].text, 'Member 2');
  const template = '\n\nconst text = ' + String.fromCharCode(96) + 'Member $' + '{index + 1}' + String.fromCharCode(96) + ';';
  assert.equal(scan(template, path)[0].line, 3);
  assert.ok(scan('"Check\\nsetup"', path).some(hit => hit.word === 'Check setup'));
  assert.ok(scan('"UNVERIFIED"', path).length);
  assert.ok(scan("'Member ' + (index + 1)", path).length);
});

test('copy vocabulary: doctor command is banned in the app only', () => {
  assert.equal(scan('"faravan doctor"', 'lib/v1/help.mjs').length, 0);
  assert.ok(scan('"faravan doctor"', 'ui/v1/src/helpers.mjs').length);
});

test('copy vocabulary: safety sentences have one source', () => {
  const safetySources = new Map(sources);
  const path = 'lib/v1/app.mjs';
  safetySources.set(path, readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
  // Frozen debt: the borrow form's internet notice moves into view-models.mjs with S5.4/U7.
  const safetyDebt = [[key({path: 'ui/v1/src/helpers.mjs', word: 'safety sentence outside view-models.mjs',
    text: 'Jobs can reach the general internet, so don\\u2019t send anything you wouldn\\u2019t want shared.'}), 1]];
  assertNoNew([...safetySources].flatMap(([path, source]) => safetyHits(source, path)), safetyDebt);
});

test('copy vocabulary: safety guard catches sentences and fragments', () => {
  const examples = [
    'Your Claude Code sign-in may be reachable from inside the sandbox while the job runs. Say yes only to people you trust.',
    'It can reach Anthropic and package registries (npm, PyPI) to install dependencies. No other websites.',
    'Runs in a fresh sandbox on your MacBook, with only the files sent for this job.',
    "It can't reach your home network, your other files or this computer.",
    'These protections are built in but not yet independently tested.',
    'sign-in stays outside the sandbox. The job can still use your allowance.',
    'Network use was not reported for this job.',
  ];
  for (const text of examples) {
    for (const path of ['ui/v1/src/main.jsx', 'lib/v1/app.mjs', 'tray/internal/new/menu.go']) {
      assert.throws(() => assertNoNew(safetyHits(JSON.stringify(text), path), []), /safety sentence/);
    }
    assert.deepEqual(safetyHits(JSON.stringify(text), 'ui/v1/src/view-models.mjs'), []);
  }
  assert.deepEqual(safetyHits('// Runs in a fresh sandbox\nconst sandbox = "sandbox";',
    'ui/v1/src/main.jsx'), []);
});

test('copy vocabulary: Go interpreted and raw literals, comments and lines', () => {
  const path = 'tray/internal/new/menu.go';
  for (const text of ['sealed', 'can reach only', 'only for this job',
    'stays outside the sandbox', 'attempt', 'Ran on', 'Merge into main']) {
    for (const quote of ['"', String.fromCharCode(96)]) {
      assert.throws(() => assertNoNew(scan('\nconst label = ' + quote + text + quote, path), []), /New banned copy/);
      assert.equal(scan('\nconst label = ' + quote + text + quote, path)[0].line, 2);
    }
  }
  assert.deepEqual(scan('// sealed\n/* Ran on */\nconst attempt = "ready"', path), []);
  assert.ok(paths.includes('tray/internal/faravantray/app.go'));
  assert.ok(paths.every(path => !path.endsWith('_test.go')));
});
