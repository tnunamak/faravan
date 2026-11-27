import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createOwnerPresence} from '../lib/v1/lending-presence.mjs';
test('tray input evidence expires; active activity is remembered conservatively',()=>{
 let now=1000000;const presence=createOwnerPresence({now:()=>now});assert.equal(presence.active(),null);
 assert.throws(()=>presence.report({idleSeconds:-1}));
 presence.report({idleSeconds:5});assert.equal(presence.active(),true);
 now+=20000;presence.report({idleSeconds:600});assert.equal(presence.active(),false);assert.equal(presence.lastActiveAt(),1000000);
 now+=61000;assert.equal(presence.active(),null);
});
