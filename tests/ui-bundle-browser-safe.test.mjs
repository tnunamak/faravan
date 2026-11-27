import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// The committed web bundle (public/v1/app.mjs) is rebuilt from ui/v1/src/main.jsx.
// A Node built-in anywhere in that import graph makes `vite build` fail, and the
// shipped bundle then silently stays stale. This walks the static graph instead
// of running vite, so the suite catches it in milliseconds.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

test('the web UI import graph uses no Node built-ins', () => {
  const entry = join(root, 'ui/v1/src/main.jsx');
  const seen = new Set(), stack = [entry], offenders = [];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith('node:')) offenders.push(`${relative(root, file)} imports ${spec}`);
      else if (spec.startsWith('.') && /\.(mjs|js|jsx)$/.test(spec)) stack.push(join(dirname(file), spec));
    }
  }
  assert.ok(seen.size > 20, `walked only ${seen.size} files`);
  assert.deepEqual(offenders, []);
});
