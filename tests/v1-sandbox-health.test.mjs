import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSandboxHealth} from '../lib/v1/sandbox-health.mjs';

test('a daemon outage notifies once until it recovers',()=>{
 let id=0;const health=createSandboxHealth({newId:()=>String(++id)});
 const observe=ok=>health.observe([{name:'sbx_daemon',ok}],{lendingOn:true});
 observe(true);observe(false);const first=health.notice;assert.equal(health.generation,1);
 assert.equal(first.id,'1');assert.match(first.reason,/Docker Sandboxes stopped/);
 observe(false);assert.equal(health.notice,first);assert.equal(health.generation,1);
 observe(true);observe(false);assert.equal(health.notice.id,'2');assert.equal(health.generation,2);
});
test('unknown observations never announce a daemon outage',()=>{
 const health=createSandboxHealth();
 health.observe([{name:'sbx_daemon',ok:false,unknown:true}],{lendingOn:true});
 health.observe([],{lendingOn:true});assert.equal(health.notice,null);
});
test('an app-initiated restart provides the same notice without a separate check',()=>{
 const health=createSandboxHealth({newId:()=> 'restart'});
 health.restarted({lendingOn:true});assert.equal(health.notice.id,'restart');
});
