import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
test('production CSP hashes the bootstrap and permits only the two Cloud connection hosts',async()=>{
  const html=await readFile(new URL('../../../public/v1/index.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const hash=createHash('sha256').update(script).digest('base64');
  assert.ok(csp.includes("script-src 'sha256-"+hash+"' blob:;"));
  assert.ok(csp.includes("connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com;"));
  assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval|\*/);
  assert.match(csp,/default-src 'none'/);
});
