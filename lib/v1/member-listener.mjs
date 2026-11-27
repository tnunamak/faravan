import {createServer} from 'node:http';
import {listenPreferred} from './listen-port.mjs';

const MEMBER_PROTOCOL_PATH=/^\/v1\/circles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/;
/** The circle id when the request target is a signed-protocol path, else null. Exact match only: no
 *  dot segments, no absolute-form target, no other prefix. */
export function memberProtocolRoute(target) {
  if(typeof target!=='string'||/[\\%]|\/\.{1,2}(?:[/?]|$)|\/\//.test(target.split('?')[0]))return null;
  return MEMBER_PROTOCOL_PATH.exec(target)?.[1]??null;
}

/** The app-owned protocol-only member listener (owner-offline topology). It binds its own loopback
 *  port, so the exposure layer (Gozar) can be pointed at this exact target and at nothing else. It
 *  holds only the member protocol: every request is either an exact signed-protocol path, answered by
 *  the member store's handler (which authenticates the signed proof against the roster target and
 *  ignores Host, Origin and forwarding headers), or refused here. It imports no tray, phone, MCP,
 *  session or account handler, so no request shaped for it - under any Host a proxy rewrites - can
 *  reach one.
 *
 *  Shutdown order, which a failed step never reorders: fence new work -> retire the exposure route
 *  (the failure is kept, not swallowed) -> drain admitted requests, or terminate them completely after
 *  `drainMs` -> close the member stores. Only then does a retire failure surface, so cleanup debt is
 *  never mistaken for a reason to leave a store open under live work. */
export function createMemberListener({serving,file,host='127.0.0.1',port=0,drainMs=5000,retire,
  setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  const work=new Set(),sockets=new Set();
  let server=null,started=null,fenced=false,closing=null;
  const refuse=(res,status,code)=>{
    if(res.headersSent)return void res.destroy();
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});
    res.end(JSON.stringify({code}));
  };
  const admit=(req,res)=>{
    if(fenced)return refuse(res,503,'member_closing');
    const circle=memberProtocolRoute(req.url);
    if(!circle)return refuse(res,404,'not_found');
    const served=(async()=>{
      const handler=await serving.ensure(circle);
      if(!handler)return refuse(res,404,'member_not_serving');
      await handler(req,res);
    })().catch(()=>refuse(res,500,'internal_error'));
    // Admitted work ends when the handler settled and its response is finished or gone.
    const ended=new Promise(done=>{res.writableFinished||res.destroyed?done():res.once('close',done);});
    const entry=Promise.all([served,ended]).then(()=>{work.delete(entry);});
    work.add(entry);
  };
  /** Bind the loopback port (once). The target is what an exposure route must forward to. */
  function start() {
    if(fenced)return Promise.reject(Object.assign(new Error('The member listener is closing'),{code:'app_closing',status:503}));
    return started??=(async()=>{
      server=createServer(admit);
      server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
      server.keepAliveTimeout=5000;
      if(file)await listenPreferred(server,{port,host,file});
      else await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
      // A fence that arrived while the port was binding wins: the new listener is released, never handed out.
      if(fenced) {
        await new Promise(done=>server.close(done));
        server.closeAllConnections?.();
        throw Object.assign(new Error('The member listener is closing'),{code:'app_closing',status:503});
      }
      const bound=server.address().port;
      return {host,port:bound,target:host+':'+bound};
    })();
  }
  /** Refuse new work now. The port stops accepting and idle connections go; admitted work continues. */
  function fence() {
    if(fenced)return;
    fenced=true;
    if(server?.listening)server.close();
    server?.closeIdleConnections?.();
  }
  async function drain() {
    let timer;
    const expired=Symbol();
    const settled=Promise.allSettled([...work]);
    const result=await Promise.race([settled,new Promise(done=>{timer=setTimer(()=>done(expired),drainMs);})]);
    clearTimer(timer);
    if(result!==expired)return;
    // Terminate: stop what the handlers still hold (bodies, parked polls), cut the sockets, and wait until
    // every admitted request has really ended. Nothing is abandoned in flight.
    serving.quiesce?.();
    for(const socket of sockets)socket.destroy();
    while(work.size)await Promise.allSettled([...work]);
  }
  function close() {
    return closing??=(async()=>{
      fence();
      await started?.catch(()=>{}); // a bind in flight settles (and releases itself) before shutdown proceeds
      let retireFailure=null;
      try {await retire?.();} catch(error) {retireFailure=error;}
      await drain();
      await new Promise(done=>{server?.listening?server.close(done):done();});
      server?.closeAllConnections?.();
      await serving.close();
      if(retireFailure)throw retireFailure;
    })();
  }
  return {start,fence,close,inFlight:()=>work.size,get server(){return server;},get target(){return server?.listening?host+':'+server.address().port:null;},
    get port(){return server?.listening?server.address().port:null;}};
}
