import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';

test('invitation preview exposes signed use bounds and the real expiry', {timeout:30000}, async t => {
  const f=await appFixture(t),owner=await f.start('owner',{pollMs:250});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const preview=await api(owner.app,'/api/circles/join-preview',{method:'POST',body:{link:invite}});
  assert.equal(preview.maxUses,1);
  assert.ok(Math.abs(Date.parse(preview.expiresAt)-Date.now()-86400000)<10000);
  const group=await owner.app.device.createInvite(circle.id,{max_uses:4});
  const groupPreview=await api(owner.app,'/api/circles/join-preview',{method:'POST',body:{link:group}});
  assert.equal(groupPreview.maxUses,4);
});

test('join preview shows signed names and only members already known on this computer', {timeout:30000}, async t => {
  const f=await appFixture(t),owner=await f.start('owner',{pollMs:250}),joiner=await f.start('joiner',{pollMs:250});
  await f.provisionFromHome('owner');
  await api(owner.app,'/api/devices',{method:'POST',body:{ownerName:'Sam'}});
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const plain=await api(joiner.app,'/api/circles/join-preview',{method:'POST',body:{link:invite}});
  assert.equal(plain.resolvedLink,undefined,'ordinary previews never echo the invitation secret');
  const preview=await api(joiner.app,'/api/circles/join-preview',{method:'POST',body:{link:invite,includeResolvedLink:true}});
  assert.equal(preview.name,'Friends');assert.equal(preview.ownerName,'Sam');
  assert.equal(preview.circle,circle.id);assert.ok(preview.resolvedLink.startsWith(f.origin+'/join#invite='));
  assert.deepEqual(preview.members,[]);assert.equal(preview.membersComplete,false);
  const known=await api(owner.app,'/api/circles/join-preview',{method:'POST',body:{link:invite}});
  assert.equal(known.membersComplete,true);assert.equal(known.members.length,1);
  assert.ok(known.members[0].device_name);
  assert.equal(known.members[0].key_id,undefined);assert.equal(known.members[0].public_key,undefined);
});
