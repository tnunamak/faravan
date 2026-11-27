import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const swift=readFileSync(new URL('../packaging/macos/launcher/main.swift',import.meta.url),'utf8');
const repeated=swift.slice(swift.indexOf('    func supervisorExited('),swift.indexOf('    func applicationShouldTerminate('));
test('native repeated-crash retry does not wait for a modal alert',()=>{
 assert.ok(repeated.includes('DispatchQueue.main.asyncAfter'));
 assert.doesNotMatch(repeated,/showRepeatedStartupFailure\s*\(|showStartupFailure\s*\(|runModal\s*\(/);
 assert.match(swift,/func startSupervisor\(\) \{\s*guard !stopping else \{ return \}/);
});
test('native repeated-crash backoff remains capped at five minutes',()=>{
 assert.match(repeated,/min\(300\.0, 5\.0 \* pow\(2\.0, Double\(min\(failures - 1, 6\)\)\)\)/);
});
