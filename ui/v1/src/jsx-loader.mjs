// Node module hook so the UI tests can import .jsx files without a build.
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';

export async function load(url, context, next) {
  if (url.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
  // Vite's `?raw` import (the icon sprite): the file text as the default export.
  if (url.endsWith('?raw')) {
    const text = await readFile(new URL(url.slice(0, -4)), 'utf8');
    return {format: 'module', source: 'export default ' + JSON.stringify(text) + ';', shortCircuit: true};
  }
  if (!url.endsWith('.jsx')) return next(url, context);
  const {code} = await transform(await readFile(new URL(url), 'utf8'), {
    loader: 'jsx', jsx: 'automatic', jsxImportSource: 'preact', format: 'esm', sourcefile: url,
  });
  return {format: 'module', source: code, shortCircuit: true};
}
