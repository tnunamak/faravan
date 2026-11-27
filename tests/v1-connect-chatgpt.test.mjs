import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {connectChatgpt,runConnectCommand} from '../lib/v1/connect-chatgpt.mjs';
import {helpFor} from '../lib/v1/help.mjs';

const hostname='owner.example.ts.net';

test('a private reach requirement cannot publish the ChatGPT gateway', async () => {
  const client={rest:()=>assert.fail('A private offer must never reach the publication endpoint')};
  await assert.rejects(connectChatgpt({tunnel:'private'},{client}),/public HTTPS/);
});

test('connect posts to the app, prints exact steps, and prints no token', async () => {
  const requests = [];
  const client = {rest:async (method, path, {body}) => { requests.push([method, path, body]);
    return {url:'https://' + hostname + '/mcp', local_url:'http://127.0.0.1:5000/chatgpt/approve'}; }};
  let text = '';
  await runConnectCommand(['chatgpt', '--tunnel', 'public', '--root', '/a', '--root', '/b'], {client, out:{write:s => { text += s; }}});
  assert.deepEqual(requests, [['POST', '/api/chatgpt/start', {tunnel:'public', roots:['/a', '/b']}]]);
  assert.match(text, /MCP URL: https:\/\/owner\.example\.ts\.net\/mcp/);
  assert.match(text, /http:\/\/127\.0\.0.1:5000\/chatgpt\/approve/);
  assert.doesNotMatch(text, /token=/);
  text = '';
  await runConnectCommand(['chatgpt', '--stop'], {client, out:{write:s => { text += s; }}});
  assert.deepEqual(requests.at(-1), ['POST', '/api/chatgpt/disconnect', {}]);
  assert.match(text, /stopped/);
  assert.deepEqual(await connectChatgpt({}, {client}), {url:'https://' + hostname + '/mcp', local_url:'http://127.0.0.1:5000/chatgpt/approve'});
  assert.equal(requests.at(-1)[2].tunnel, undefined);
  await assert.rejects(runConnectCommand(['chatgpt', '--stop', '--root', '/a'], {client}), /cannot be combined/);
  await assert.rejects(runConnectCommand(['other'], {client}), /usage/);
});

const started={url:'https://' + hostname + '/mcp', local_url:'http://127.0.0.1:5000/connect/chatgpt'};
const pend=(code,host='chatgpt.com')=>({matching_code:code,redirect_host:host,client:'ChatGPT',is_chatgpt:host==='chatgpt.com',scope:'read act'});
function watcher({statuses,tty=true,failWith}={}) {
  const clock={t:1_000_000},slept=[],calls=[],queue=[...statuses];
  const client={rest:async(method,path)=>{
    calls.push([method,path]);
    if(path==='/api/chatgpt/start')return started;
    if(failWith)throw failWith;
    return queue.length>1?queue.shift():queue[0];
  }};
  let text='';const out={isTTY:tty,write:s=>{text+=s;}};
  const seams={client,out,now:()=>clock.t,sleep:async ms=>{slept.push(ms);clock.t+=ms;}};
  return {seams,out,calls,slept,clock,text:()=>text};
}

test('interactive connect prints each new pending matching code once, then stops when pairing closes',async()=>{
  const w=watcher({statuses:[
    {pairing_until:2_000_000,pending_requests:[]},
    {pairing_until:2_000_000,pending_requests:[pend('1A2B-3C4D')]},
    {pairing_until:2_000_000,pending_requests:[pend('1A2B-3C4D'),pend('FFFF-0000','127.0.0.1:43210')]},
    {pairing_until:null,pending_requests:[]},
  ]});
  assert.equal(await runConnectCommand(['chatgpt'],w.seams),0);
  const text=w.text();
  assert.match(text,/MCP URL: https:\/\/owner\.example\.ts\.net\/mcp/);
  assert.equal(text.split('1A2B-3C4D').length,2,'a code prints once');
  assert.match(text,/FFFF-0000/);assert.match(text,/127\.0\.0\.1:43210/);assert.match(text,/chatgpt\.com/);
  assert.match(text,/compare/i);assert.match(text,/ChatGPT/);
  assert.match(text,/pairing (is )?closed/i);
  assert.equal(w.calls.filter(c=>c[1]==='/api/chatgpt/status').length,4);
  assert.ok(w.slept.length>=3&&w.slept.every(ms=>ms>=500&&ms<=10000),'bounded polling interval');
  assert.doesNotMatch(text,/token=/);
});

test('interactive connect stops at ten minutes when pairing never closes',async()=>{
  const w=watcher({statuses:[{pairing_until:99_000_000,pending_requests:[]}]});
  assert.equal(await runConnectCommand(['chatgpt'],w.seams),0);
  assert.ok(w.clock.t-1_000_000<=600_000+10_000&&w.clock.t-1_000_000>=600_000,'ran ten minutes, then stopped: '+(w.clock.t-1_000_000));
  assert.match(w.text(),/10 minutes|ten minutes|timed out|stopped waiting/i);
});

test('interactive connect exits honestly after repeated status failures, not a hang',async()=>{
  const w=watcher({statuses:[{}],failWith:new Error('ECONNREFUSED')});
  const code=await runConnectCommand(['chatgpt'],w.seams);
  assert.equal(code,1);assert.match(w.text(),/ECONNREFUSED|could not check/i);assert.match(w.text(),/127\.0\.0\.1:5000\/connect\/chatgpt/);
  assert.ok(w.calls.filter(c=>c[1]==='/api/chatgpt/status').length<=10);
});

test('an interrupt ends the watcher without error',async()=>{
  const ac=new AbortController();
  const w=watcher({statuses:[{pairing_until:99_000_000,pending_requests:[]}]});
  w.seams.sleep=async()=>{ac.abort();};w.seams.signal=ac.signal;
  assert.equal(await runConnectCommand(['chatgpt'],w.seams),0);
  assert.equal(w.calls.filter(c=>c[1]==='/api/chatgpt/status').length,1);
});

test('non-TTY, JSON and stop never poll and return promptly',async()=>{
  for(const [argv,tty] of [[['chatgpt'],false],[['chatgpt','--json'],true],[['chatgpt','--json'],false],[['chatgpt','--stop'],true]]){
    const w=watcher({statuses:[{pairing_until:99_000_000,pending_requests:[pend('AAAA-BBBB')]}],tty});
    assert.equal(await runConnectCommand(argv,w.seams),0);
    assert.equal(w.calls.filter(c=>c[1]==='/api/chatgpt/status').length,0,argv.join(' ')+' tty='+tty);
    assert.equal(w.slept.length,0);
  }
  const w=watcher({statuses:[{}],tty:false});await runConnectCommand(['chatgpt'],w.seams);
  assert.match(w.text(),/127\.0\.0\.1:5000\/connect\/chatgpt/,'points at the local connect screen');
});

test('JSON output includes pending codes when the app already returned them',async()=>{
  const w=watcher({statuses:[{}],tty:false});
  w.seams.client.rest=async()=>({...started,pending_requests:[pend('AAAA-BBBB')]});
  await runConnectCommand(['chatgpt','--json'],w.seams);
  assert.equal(JSON.parse(w.text()).pending_requests[0].matching_code,'AAAA-BBBB');
});

test('connect has help', () => assert.match(helpFor(['connect']), /faravan connect chatgpt/));
