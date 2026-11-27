import {createServer} from 'node:http';
import {Duplex} from 'node:stream';
import {serveAccountProxy} from './account-transport.mjs';

// A private, host-controlled route from one guest to the host broker.
//
// The guest cannot reach the host over any network: sandbox policy denies
// private, loopback and tailnet ranges, and an operator-supplied HTTPS
// hostname is not something a clean install has. The host already controls
// one channel into the guest, `sbx exec -i`. This module runs a small relay
// on that channel. The relay listens on the guest's own loopback and carries
// each accepted connection over the exec stdio as framed bytes. On the host,
// each connection becomes a stream fed to a normal HTTP server whose handler
// is the broker's account proxy (same job-key, provider, model, effort,
// attempt and expiry checks as any other guest request).
//
// Trust: the guest-loopback leg is cleartext HTTP, but it never leaves the
// guest kernel, and the exec channel is the same host-to-guest channel that
// already carries the job. No network egress is opened and no TLS is removed
// from any provider-facing hop (the broker still speaks HTTPS to providers).
// Only the one job's own processes can reach the loopback listener, and a
// request without that job's current key is refused by the broker.

export const TUNNEL_PORT=18437;
export const TUNNEL_ORIGIN='http://127.0.0.1:'+TUNNEL_PORT;
const READY=0,OPEN=1,DATA=2,CLOSE=3,HEADER=9,CHUNK=64*1024,MAX_CONNECTIONS=16;

const frame=(type,id,payload=Buffer.alloc(0))=>{
  const head=Buffer.alloc(HEADER);head.writeUInt8(type,0);head.writeUInt32BE(id,1);head.writeUInt32BE(payload.length,5);
  return Buffer.concat([head,payload]);
};
function frameReader(onFrame){
  let buffered=Buffer.alloc(0);
  return chunk=>{
    buffered=Buffer.concat([buffered,chunk]);
    while(buffered.length>=HEADER){
      const length=buffered.readUInt32BE(5);
      if(length>CHUNK)throw Error('tunnel_frame_too_large');
      if(buffered.length<HEADER+length)return;
      onFrame(buffered.readUInt8(0),buffered.readUInt32BE(1),buffered.subarray(HEADER,HEADER+length));
      buffered=buffered.subarray(HEADER+length);
    }
  };
}

// Runs in the guest as `node -e <source> <port>`. Plain CommonJS, no dependencies.
export const GUEST_RELAY_SOURCE=`
const net=require('net'),HEADER=${HEADER},CHUNK=${CHUNK};
const frame=(t,i,p)=>{p=p||Buffer.alloc(0);const h=Buffer.alloc(HEADER);h.writeUInt8(t,0);h.writeUInt32BE(i,1);h.writeUInt32BE(p.length,5);return Buffer.concat([h,p]);};
const sockets=new Map();let next=1,buffered=Buffer.alloc(0);
const send=b=>process.stdout.write(b);
const server=net.createServer(s=>{
  if(sockets.size>=${MAX_CONNECTIONS}){s.destroy();return;}
  const id=next++;sockets.set(id,s);send(frame(${OPEN},id));
  s.on('data',d=>{for(let o=0;o<d.length;o+=CHUNK)send(frame(${DATA},id,d.subarray(o,o+CHUNK)));});
  s.on('close',()=>{if(sockets.delete(id))send(frame(${CLOSE},id));});
  s.on('error',()=>{});
});
server.on('error',()=>process.exit(3));
process.stdin.on('data',c=>{
  buffered=Buffer.concat([buffered,c]);
  while(buffered.length>=HEADER){
    const n=buffered.readUInt32BE(5);if(buffered.length<HEADER+n)return;
    const t=buffered.readUInt8(0),id=buffered.readUInt32BE(1),p=buffered.subarray(HEADER,HEADER+n);buffered=buffered.subarray(HEADER+n);
    const s=sockets.get(id);if(!s)continue;
    if(t===${DATA})s.write(p);else if(t===${CLOSE}){sockets.delete(id);s.end();}
  }
});
process.stdin.on('end',()=>process.exit(0));
server.listen(Number(process.argv[1]),'127.0.0.1',()=>send(frame(${READY},0)));
`;

// The same relay for guests that ship python3 but no node (the Codex agent image is a native binary).
export const GUEST_RELAY_PYTHON_SOURCE=`
import os,socket,struct,sys,threading
H=${HEADER};C=${CHUNK}
out=sys.stdout.buffer;inp=sys.stdin.buffer;lock=threading.Lock();socks={};state={'next':1}
def send(t,i,p=b''):
    with lock:
        out.write(struct.pack('>BII',t,i,len(p))+p);out.flush()
def pump(i,s):
    try:
        while True:
            d=s.recv(C)
            if not d:break
            for o in range(0,len(d),C):send(${DATA},i,d[o:o+C])
    except OSError:pass
    if socks.pop(i,None) is not None:send(${CLOSE},i)
    try:s.close()
    except OSError:pass
srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
try:srv.bind(('127.0.0.1',int(sys.argv[1])));srv.listen(16)
except OSError:os._exit(3)
def accept():
    while True:
        c,_=srv.accept()
        if len(socks)>=${MAX_CONNECTIONS}:c.close();continue
        i=state['next'];state['next']+=1;socks[i]=c;send(${OPEN},i)
        threading.Thread(target=pump,args=(i,c),daemon=True).start()
threading.Thread(target=accept,daemon=True).start()
send(${READY},0)
def exact(n):
    b=b''
    while len(b)<n:
        d=inp.read(n-len(b))
        if not d:os._exit(0)
        b+=d
    return b
while True:
    t,i,n=struct.unpack('>BII',exact(H));p=exact(n) if n else b''
    s=socks.get(i)
    if s is None:continue
    if t==${DATA}:
        try:s.sendall(p)
        except OSError:pass
    elif t==${CLOSE}:
        socks.pop(i,None)
        try:s.shutdown(socket.SHUT_WR)
        except OSError:pass
`;

// Runs in the guest through `sh -c`: node when present, else python3, else a clear refusal.
const GUEST_RELAY_LAUNCHER='if command -v node >/dev/null 2>&1; then exec node -e "$2" "$1"; '+
  'elif command -v python3 >/dev/null 2>&1; then exec python3 -c "$3" "$1"; '+
  'else echo "no guest runtime for the broker relay (needs node or python3)" >&2; exit 127; fi';
/** The argv that follows `sbx exec -i <sandbox> --`. */
export const guestRelayArgv=(port=TUNNEL_PORT)=>['sh','-c',GUEST_RELAY_LAUNCHER,'faravan-relay',String(port),GUEST_RELAY_SOURCE,GUEST_RELAY_PYTHON_SOURCE];

/**
 * Attach the host end to a relay's stdio. `child` needs stdin, stdout and kill().
 * Resolves once the guest reports its listener is up.
 */
export function attachGuestBrokerTunnel({child,handler,signal,readyTimeoutMs=30000}) {
  const connections=new Map();
  const server=createServer({requestTimeout:0,headersTimeout:30000},handler);
  let closed=false,markReady,markFailed;
  const ready=new Promise((resolve,reject)=>{markReady=resolve;markFailed=reject;});
  const write=buffer=>{if(!closed&&child.stdin.writable)child.stdin.write(buffer);};
  const closeConnection=(id,notify)=>{
    const connection=connections.get(id);if(!connection)return;
    connections.delete(id);if(notify)write(frame(CLOSE,id));connection.destroy();
  };
  const read=frameReader((type,id,payload)=>{
    if(type===READY){markReady();return;}
    if(type===OPEN){
      const connection=new Duplex({
        read(){},
        write(chunk,_encoding,done){for(let o=0;o<chunk.length;o+=CHUNK)write(frame(DATA,id,chunk.subarray(o,o+CHUNK)));done();},
        final(done){write(frame(CLOSE,id));done();},
      });
      connection.setTimeout=()=>connection;connection.setNoDelay=()=>connection;connection.setKeepAlive=()=>connection;
      connection.once('close',()=>connections.delete(id));
      connections.set(id,connection);server.emit('connection',connection);return;
    }
    const connection=connections.get(id);if(!connection)return;
    if(type===DATA)connection.push(payload);
    else if(type===CLOSE){connection.push(null);}
  });
  const close=()=>{
    if(closed)return;closed=true;
    for(const id of [...connections.keys()])closeConnection(id,false);
    try{child.stdin.end();}catch{/* already closed */}
    try{child.kill('SIGKILL');}catch{/* already exited */}
    server.close();
    markFailed(Error('tunnel_closed'));
  };
  child.stdout.on('data',chunk=>{try{read(chunk);}catch{close();}});
  child.once('close',close);child.once('error',close);
  child.stdin.on('error',()=>{});
  if(signal){if(signal.aborted)close();else signal.addEventListener('abort',close,{once:true});}
  const timer=setTimeout(close,readyTimeoutMs);timer.unref?.();
  ready.finally(()=>clearTimeout(timer)).catch(()=>{});
  return {ready,close,get connections(){return connections.size;}};
}

/** The broker's own account proxy, locked to one provider, as the tunnel's HTTP handler. */
export function accountProxyRequestListener({providerId,providers,broker}) {
  return (req,res)=>{void serveAccountProxy({req,res,providerId,providers,broker}).catch(()=>res.destroy());};
}
