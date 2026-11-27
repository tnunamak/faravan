import test from 'node:test';
import assert from 'node:assert/strict';
import { Circle, CircleProfileSettings } from './circles.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';
import { circlesListVM, circleHostingVM } from './circles-view.mjs';
test('all hosted circles report this computer, with purpose in the list model',()=>{
 const circles=[{id:'a',name:'Friends',origin:'https://host',purpose:'Weekend projects'},{id:'b',name:'Neighbours',origin:'https://host'}];
 const hosting={configured:true,running:true,circle:'a',circles:circles.map(({id,name})=>({id,name}))};
 const rows=circlesListVM(circles,{},hosting);
 assert.ok(rows.every(row=>row.meta.includes('Hosted on this computer')));
 assert.equal(rows[0].purpose,'Weekend projects');
 assert.equal(circleHostingVM(circles[1],hosting).canStop,true);
});
test('only owners get editable signed circle settings',()=>{
 const circle={id:'c',name:'Friends',purpose:'Weekend projects',owned:true};
 const out=renderFixture(CircleProfileSettings,{circle,mutate(){}});
 assert.match(out,/value="Friends"/);assert.match(out,/value="Weekend projects"/);
 assert.match(renderedText(out),/Circle name Purpose .*Save circle/);
 assert.equal(renderFixture(CircleProfileSettings,{circle:{...circle,owned:false},mutate(){}}),'');
});

test('circle headers and lists count computers without presenting them as people',()=>{
 const circle={id:'c',name:'Friends',origin:'https://host',owned:true};
 for(const count of [1,2]){
  const members=Array.from({length:count},(_,index)=>({key_id:'key-'+index,device_name:'Member '+index}));
  const devices={circles:[{circle:'c',members}]};
  const out=renderFixture(Circle,{id:'c',circles:[circle],data:{devices},api:{},mutate(){},setDialog(){}});
  assert.match(renderedText(out),new RegExp('\\b'+count+' computer'+(count===1?'':'s')));
  assert.doesNotMatch(renderedText(out),/\d+ members?\b/);
  assert.match(circlesListVM([circle],devices,null)[0].meta,new RegExp(count+' computer'+(count===1?'':'s')));
 }
});
