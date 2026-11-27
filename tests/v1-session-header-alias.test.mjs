import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {requestToken} from '../lib/v1/loopback-security.mjs';

test('Faravan session header carries the credential', () => {
  assert.equal(requestToken({headers:{'x-faravan-session-token':'new'}}), 'new');
});
test('a session token in the query string is never a credential', () => {
  assert.equal(requestToken({headers:{}}), null);
  assert.equal(requestToken({headers:{'x-faravan-session-token':''}}), null);
});

async function legacyDaemon(t) {
  const {createServer} = await import('node:http');
  const {mkdtemp,mkdir,writeFile,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const home = await mkdtemp(join(tmpdir(),'legacy-daemon-'));
  const token = 'synthetic-transition-token';
  const server = createServer((req,res) => {
    const allowed = req.headers['x-faravan-session-token'] === token;
    res.writeHead(allowed?200:401,{'content-type':'application/json'});
    res.end(JSON.stringify(!allowed?{code:'unauthorized'}:req.url==='/api/handoff'?{url:'http://127.0.0.1:'+server.address().port+'/auth/handoff?code=legacy-once'}:{enabled:false,intent:'off'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
  await mkdir(join(home,'v1'));
  await writeFile(join(home,'v1/app.json'),JSON.stringify({pid:process.pid,port:server.address().port,token}));
  return {home,token,origin:'http://127.0.0.1:'+server.address().port};
}

async function additionalLegacyListener(t) {
  const {createServer}=await import('node:http');
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const home=await mkdtemp(join(tmpdir(),'additional-legacy-')), token='synthetic-additional-token', seen=[];
  let origin;
  const server=createServer((req,res)=>{
    seen.push({path:req.url,method:req.method,headers:req.headers});
    const allowed=req.headers['x-faravan-session-token']===token;
    const absent=req.url.startsWith('/api/ops');
    res.writeHead(!allowed?401:absent?404:200,{'content-type':'application/json'});
    res.end(JSON.stringify(!allowed?{code:'unauthorized'}:absent?{code:'not_found'}:
      req.url==='/api/handoff'?{url:origin+'/auth/handoff?code=synthetic-once'}:
      req.url==='/api/circles'?[]:{enabled:false}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
  await mkdir(join(home,'v1'));
  await writeFile(join(home,'v1/app.json'),JSON.stringify({pid:process.pid,port:server.address().port,token}));
  return {home,origin,token,seen};
}
function assertAdditionalHeaders(d) {
  assert.ok(d.seen.length);
  for(const request of d.seen){
    assert.equal(request.headers['x-faravan-session-token'],d.token);
    assert.equal(request.headers['x-faravan-session-token'],d.token);
    assert.ok(!request.path.includes(d.token));
  }
}
// The UI signs in with the HttpOnly handoff cookie, so its bootstrap sends no session header under either name.
test('the bootstrap sends no session token header under either alias',async()=>{
  const {bootstrap}=await import('../ui/v1/src/bootstrap.mjs');
  assert.ok(!bootstrap.toString().includes('x-faravan-session-token'));
  assert.ok(!bootstrap.toString().includes('x-faravan-session-token'));
});
