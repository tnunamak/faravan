#!/usr/bin/env node
// `npm run test:browser`: rebuild the UI, run the V1 lane headless, print the table.
// Default (exploratory): forwards any Playwright arguments (--list, --grep, ...) and exits with Playwright's status.
// `--release` (the gate, used by npm run test:browser): takes no other arguments, so the whole lane runs, and the
// report must prove it ran (see browser-verify-lib.mjs). Both modes exit 1 unless Playwright and the report both pass.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { RESULTS_FILE } from './browser-verify-lib.mjs';

// Headless only: the lane never needs a display, and must not reach for the user's.
const env = {...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', GDK_BACKEND: 'x11', GTK_USE_PORTAL: '0'};
const run = (command, args, options = {}) => spawnSync(command, args, {stdio: 'inherit', env, ...options});

const release = process.argv.includes('--release');
const forwarded = process.argv.slice(2).filter(arg => arg !== '--release');
if (release && forwarded.length) {
  console.error(`--release runs the whole V1 lane and takes no other arguments; got: ${forwarded.join(' ')}`);
  process.exit(2);
}

// The report must come from this run: an earlier run's results must not stand in for a run that failed to write one.
rmSync(RESULTS_FILE, {force: true});
if (!existsSync('ui/node_modules/esbuild')) run('npm', ['--prefix', 'ui', 'ci', '--silent']);
if (run('npm', ['--prefix', 'ui', 'run', 'build', '--silent']).status !== 0) process.exit(1);
const started = Date.now();
const result = run('npx', ['playwright', 'test', '-c', 'playwright.verify.config.mjs', ...forwarded]);
const report = run(process.execPath, ['scripts/browser-verify-report.mjs', String(Math.round((Date.now() - started) / 1000)), ...(release ? ['--release'] : [])]);
// A reporter or validator failure is a failure even when Playwright exited 0 (for example, a --reporter override).
process.exit(result.status === 0 && report.status === 0 ? 0 : (result.status || 1));
