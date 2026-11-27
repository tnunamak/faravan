import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {resultReviewMetadata} from '../lib/v1/result-review.mjs';
test('coverage counts bytes and lines from the complete signed patch, and hashes each exact file section',()=>{
 const patch='diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+é\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n';
 const bytes=Buffer.from(patch);const visible=patch.slice(0,patch.indexOf('diff --git a/b'));
 const view={diff:visible,files:[{path:'a'},{path:'b'}]};const meta=resultReviewMetadata(bytes,view);
 assert.equal(meta.total_lines,12);assert.equal(meta.shown_bytes,Buffer.byteLength(visible));assert.match(meta.files[0].hash,/^sha256:[a-f0-9]{64}$/);
 const changed=resultReviewMetadata(Buffer.from(patch.replace('+y','+z')),view);assert.equal(meta.files[0].hash,changed.files[0].hash);assert.notEqual(meta.files[1].hash,changed.files[1].hash);
});
