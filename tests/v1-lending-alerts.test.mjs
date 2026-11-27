import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createNotificationFeed,notificationSettings,validNotificationRoute} from '../lib/v1/notifications.mjs';
test('allowance warnings notify once per window, survive restart and respect history settings',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lending-alert-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const settings=notificationSettings(),feed=await createNotificationFeed(dir),cursor=feed.read().cursor;
 const row={provider:'codex',windowId:'codex:10080',resetsAt:1,threshold:10,used:11};
 await feed.lendingWarning(row,settings);await feed.lendingWarning(row,settings);
 let notes=feed.read(cursor).notifications;assert.equal(notes.length,1);assert.equal(notes[0].category,'lending_attention');assert.equal(notes[0].route,'#/lend/limits');assert.match(notes[0].body,/10%/);
 assert.equal(validNotificationRoute(notes[0].route),true);assert.equal(validNotificationRoute('#/settings/anything'),false);
 const reopened=await createNotificationFeed(dir),after=reopened.read().cursor;
 await reopened.lendingWarning(row,settings);assert.equal(reopened.read(after).notifications.length,0);
 await reopened.lendingWarning({...row,resetsAt:2},settings);assert.equal(reopened.read(after).notifications.length,1);
 await reopened.lendingWarning({...row,resetsAt:3,threshold:0},settings);assert.equal(reopened.read(after).notifications.length,1,'zero disables warnings');
 const silent=notificationSettings({lending_attention:{history:false,desktop:true}});
 await reopened.lendingWarning({...row,resetsAt:4},silent);assert.equal(reopened.read().history.length,2);assert.equal(reopened.read(after).notifications.length,2);
});
