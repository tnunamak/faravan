import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {focusOutcome, restoreFocus} from './focus.mjs';

test('restoreFocus waits until modal inertness ends, uses its trigger, and falls back to the outcome', () => {
  const oldDocument = globalThis.document, oldFrame = globalThis.requestAnimationFrame;
  const calls = [], notice = {textContent:'Saved.', focus:() => calls.push('notice')};
  let frame;
  globalThis.document = {querySelector:s => s === '.notice' ? notice : null};
  globalThis.requestAnimationFrame = fn => {frame=fn;};
  try {
    const trigger = {isConnected:true, disabled:false, focus:() => {
      calls.push('trigger'); globalThis.document.activeElement = trigger;
    }};
    restoreFocus(trigger);
    assert.deepEqual(calls, []);
    frame(); assert.deepEqual(calls, ['trigger']);
    restoreFocus({isConnected:false}); frame();
    assert.deepEqual(calls, ['trigger', 'notice']);
    assert.equal(notice.tabIndex, -1);
    const heading = {focus:() => calls.push('heading')};
    globalThis.document = {querySelector:s => s === 'h1' ? heading : null};
    focusOutcome(); assert.equal(calls.at(-1), 'heading');
  } finally {globalThis.document=oldDocument;globalThis.requestAnimationFrame=oldFrame;}
});


// Each case owns its Window and frame queue; no global mounted-test environment.
async function inFocusWindow(inspect) {
  const keys = ['document', 'requestAnimationFrame'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  const owned = new Window({url:'http://127.0.0.1/'});
  const frames = [];
  try {
    Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:owned.document});
    Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,writable:true,value:fn => frames.push(fn)});
    owned.document.body.innerHTML = '<main><h1>Result</h1><p class="notice">Saved.</p><div id="holder"><button id="trigger">Open</button></div></main>';
    const doc = owned.document, trigger = doc.querySelector('#trigger');
    await inspect({doc,trigger,holder:doc.querySelector('#holder'),frames,
      frame() { assert.equal(frames.length,1); frames.shift()(); }});
  } finally {
    frames.length = 0;
    try {
      owned.document.body.replaceChildren();
      await owned.happyDOM.close();
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis,key,descriptor);
        else delete globalThis[key];
      }
    }
  }
}
test('restoreFocus actually reaches a visible attached control after one frame without scrolling', async () => {
  await inFocusWindow(({doc,trigger,frame}) => {
    const original = trigger.focus.bind(trigger), calls = [];
    trigger.focus = options => {calls.push(options);original(options);};
    restoreFocus(trigger);
    assert.notEqual(doc.activeElement,trigger);
    assert.deepEqual(calls,[]);
    frame();
    assert.equal(doc.activeElement,trigger);
    assert.deepEqual(calls,[{preventScroll:true}]);
  });
});
for (const [name,change] of [
  ['hidden attribute', ({trigger}) => {trigger.hidden=true;}],
  ['hidden ancestor', ({holder}) => {holder.hidden=true;}],
  ['inert ancestor', ({holder}) => {holder.setAttribute('inert','');}],
  ['inert target', ({trigger}) => {trigger.setAttribute('inert','');}],
  ['display none ancestor', ({holder}) => {holder.style.display='none';}],
  ['display none ancestor with visible child', ({holder,trigger}) => {holder.style.display='none';trigger.style.visibility='visible';}],
  ['visibility hidden', ({trigger}) => {trigger.style.visibility='hidden';}],
  ['visibility collapse', ({trigger}) => {trigger.style.visibility='collapse';}],
  ['disabled after scheduling', ({trigger}) => {trigger.disabled=true;}],
  ['detached after scheduling', ({trigger}) => {trigger.remove();}],
]) test('restoreFocus rejects ' + name + ' at the scheduled callback', async () => {
  await inFocusWindow(context => {
    const {doc,trigger,frame} = context;
    let attempts=0;
    trigger.focus = () => {attempts++;};
    restoreFocus(trigger);
    change(context);
    frame();
    assert.equal(attempts,0,'ineligible controls must not be focused');
    assert.equal(doc.activeElement,doc.querySelector('.notice'));
    assert.equal(doc.activeElement.tabIndex,-1);
  });
});
test('restoreFocus verifies transfer rather than trusting a no-op focus method', async () => {
  await inFocusWindow(({doc,trigger,frame}) => {
    const calls=[];
    trigger.focus = options => {calls.push(options);};
    restoreFocus(trigger);frame();
    assert.deepEqual(calls,[{preventScroll:true}]);
    assert.equal(doc.activeElement,doc.querySelector('.notice'));
  });
});
test('restoreFocus catches an eligible trigger focus failure and focuses the real notice after one deferred frame', async () => {
  await inFocusWindow(({doc,trigger,frames,frame}) => {
    const notice=doc.querySelector('.notice'), calls=[];
    const sentinel=new Error('owned trigger focus failure');
    assert.equal(trigger.isConnected,true);
    assert.equal(trigger.disabled,false);
    assert.equal(trigger.hidden,false);
    trigger.focus=options=>{calls.push(options);throw sentinel;};
    const before=doc.activeElement;
    restoreFocus(trigger);
    assert.equal(frames.length,1,'exactly one owned frame is deferred');
    assert.deepEqual(calls,[],'the eligible trigger is not attempted synchronously');
    assert.equal(doc.activeElement,before);
    assert.notEqual(doc.activeElement,notice);
    assert.doesNotThrow(frame,'the scheduled callback catches the trigger failure');
    assert.equal(frames.length,0,'the owned frame was consumed without scheduling another');
    assert.deepEqual(calls,[{preventScroll:true}],'the eligible trigger was attempted exactly once');
    assert.equal(doc.activeElement,notice,'the real notice receives focus after the exception');
    assert.equal(notice.tabIndex,-1);
  });
});
test('restoreFocus retries a trigger made eligible before the scheduled callback', async () => {
  await inFocusWindow(({doc,trigger,frame}) => {
    trigger.disabled=true;
    restoreFocus(trigger);
    trigger.disabled=false;
    frame();
    assert.equal(doc.activeElement,trigger);
  });
});
for (const mode of ['notice','heading','main','absent']) test('restoreFocus absent trigger outcome: '+mode, async () => {
  await inFocusWindow(({doc,frame}) => {
    const notice=doc.querySelector('.notice'), heading=doc.querySelector('h1'), main=doc.querySelector('main');
    if(mode!=='notice') notice.textContent=' \n\t';
    if(mode==='main'||mode==='absent') heading.remove();
    if(mode==='absent') main.remove();
    const expected=mode==='notice'?notice:mode==='heading'?heading:mode==='main'?main:doc.body;
    const calls=[];
    if(expected!==doc.body) {
      const focus=expected.focus.bind(expected);
      expected.focus=options=>{calls.push(options);focus(options);};
    }
    restoreFocus(undefined);
    assert.doesNotThrow(frame);
    assert.equal(doc.activeElement,expected);
    if(expected!==doc.body) {
      assert.equal(expected.tabIndex,-1);
      assert.deepEqual(calls,[{preventScroll:true}]);
    }
  });
});

for (const timing of ['before scheduling', 'after scheduling']) test('restoreFocus honors a visible override ' + timing, async () => {
  await inFocusWindow(({doc,trigger,holder,frame}) => {
    holder.style.visibility='hidden';
    const notice=doc.querySelector('.notice'), calls=[], fallback=[];
    const focus=trigger.focus.bind(trigger), noticeFocus=notice.focus.bind(notice);
    trigger.focus=options=>{calls.push(options);focus(options);};
    notice.focus=options=>{fallback.push(options);noticeFocus(options);};
    if(timing==='before scheduling') trigger.style.visibility='visible';
    else assert.equal(doc.defaultView.getComputedStyle(trigger).visibility,'hidden',
      'owned DOM must establish inherited visibility without a style stub');
    restoreFocus(trigger);
    assert.deepEqual(calls,[]);
    assert.deepEqual(fallback,[]);
    assert.notEqual(doc.activeElement,trigger);
    if(timing==='after scheduling') trigger.style.visibility='visible';
    assert.equal(doc.defaultView.getComputedStyle(holder).visibility,'hidden');
    assert.equal(doc.defaultView.getComputedStyle(trigger).visibility,'visible');
    frame();
    assert.equal(doc.activeElement,trigger,'real focus transfer, not merely a method call');
    assert.deepEqual(calls,[{preventScroll:true}]);
    assert.deepEqual(fallback,[],'successful focus must not invoke the outcome');
  });
});
for (const timing of ['already inherited', 'override removed after scheduling']) test('restoreFocus rejects inherited hidden visibility: ' + timing, async () => {
  await inFocusWindow(({doc,trigger,holder,frame}) => {
    holder.style.visibility='hidden';
    if(timing==='override removed after scheduling') trigger.style.visibility='visible';
    const calls=[], focus=trigger.focus.bind(trigger);
    trigger.focus=options=>{calls.push(options);focus(options);};
    restoreFocus(trigger);
    if(timing==='override removed after scheduling') trigger.style.removeProperty('visibility');
    assert.equal(doc.defaultView.getComputedStyle(trigger).visibility,'hidden',
      'owned DOM must establish inherited visibility without a style stub');
    frame();
    assert.deepEqual(calls,[]);
    assert.equal(doc.activeElement,doc.querySelector('.notice'));
  });
});
