import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {opById} from '../lib/v1/ops/registry.mjs';
import {opsRoute} from '../lib/v1/ops/cli.mjs';
import {realCoordinator} from './helpers/v1-short-invite.mjs';

test('circle details have one registered owner operation on every surface',()=>{
 const op=opById('circles.set_profile');assert.ok(op);
 assert.equal(op.rest.path,'/api/circles/{circle}/profile');
 assert.equal(opsRoute(['circles','set-profile']).op.id,op.id);
});

test('circle settings route publishes verified details and refuses a member',async t=>{
 const f=await appFixture(t),c=await realCoordinator(t,{name:'Friends'}),circle=c.circle;
 const member=await c.device('member'),links=await c.owner.createInviteLinks(circle.id);
 await member.joinCircle(links.long,{waitMs:0});await c.owner.approveEnrollments(circle.id);await member.refreshRoster(circle.id);
 const owner=await f.start('owner',{device:c.owner}),lender=await f.start('lender',{device:member});
 const updated=await api(owner.app,'/api/circles/'+circle.id+'/profile',{method:'POST',body:{name:'Neighbours',purpose:'Small fixes for our street'}});
 assert.equal(updated.name,'Neighbours');assert.equal(updated.purpose,'Small fixes for our street');
 await lender.app.device.refreshRoster(circle.id);
 const joined=(await api(lender.app,'/api/circles')).find(c=>c.id===circle.id);
 assert.equal(joined.name,'Neighbours');assert.equal(joined.purpose,'Small fixes for our street');
 const denied=await api(lender.app,'/api/circles/'+circle.id+'/profile',{method:'POST',body:{name:'Other'},status:403});
 assert.equal(denied.code,'not_owner');
 const bad=await api(owner.app,'/api/circles/'+circle.id+'/profile',{method:'POST',body:{untrusted:true},status:400});
 assert.equal(bad.code,'invalid_request');
});
