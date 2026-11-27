import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap} from './bootstrap.mjs';
import {takeSession} from './helpers.mjs';

// A stale ?token= link from history must neither sign the page in nor leave anything behind.
test('a ?token= page load sends no session header and leaves session storage empty', async () => {
  const saved = new Map([['faravan-session', 'STORED-SECRET']]);
  const storage = {getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k)};
  const calls = [], replaced = [];
  const target = {innerHTML: '', textContent: '', removeAttribute() {}};
  const stubs = {
    location: {href: 'http://127.0.0.1:8/?token=OLD-LINK-TOKEN#/home', hostname: '127.0.0.1'},
    history: {state: null, replaceState: (...args) => replaced.push(args)},
    sessionStorage: storage,
    document: {getElementById: () => target, createElement: () => ({}), head: {append() {}}, documentElement: {dataset: {}}},
    matchMedia: () => ({matches: false}),
    fetch: async (path, options) => {
      calls.push({path, options});
      return {ok: false, status: 401, text: async () => ''};
    },
  };
  const saveGlobals = Object.fromEntries(Object.keys(stubs).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, stubs);
  try {
    await bootstrap(takeSession, '', () => ({text: 'Reconnect to Faravan'}));
  } finally {
    Object.assign(globalThis, saveGlobals);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/app.mjs');
  const headers = calls[0].options.headers ?? {};
  assert.deepEqual(Object.keys(headers).filter(name => /session/i.test(name)), []);
  assert.equal(JSON.stringify(calls).includes('OLD-LINK-TOKEN'), false, 'the stale token never reaches a request');
  assert.equal(saved.size, 0, 'session storage is empty after boot');
  assert.deepEqual(replaced.at(-1), [null, '', '/#/home'], 'the token is stripped from the address bar');
});
