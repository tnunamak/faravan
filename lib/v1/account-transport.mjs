import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {ok,fault} from './accounts.mjs';

async function boundedBytes(stream,limit,signal) {
  if(!stream)return Buffer.alloc(0);
  const reader=stream.getReader(),chunks=[];let size=0;
  const abort=()=>{void reader.cancel('aborted').catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try {for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>limit)throw Error('payload_too_large');chunks.push(Buffer.from(value));}
    signal?.throwIfAborted();return Buffer.concat(chunks);
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}

// Streams a provider reply to the guest. Output is delayed by the host secret's length so a credential split across
// chunks is never emitted whole; a match, the byte bound, an idle gap or a revoke ends the stream with an error.
function streamingBody(source,{secret,limit,controller,observe,contentType,onObservation,idleMs=120000,release}) {
  const hold=secret?Buffer.byteLength(secret):0,needle=secret?Buffer.from(secret):null;
  const keep=observe?[]:null;let kept=0,total=0,tail=Buffer.alloc(0),reader,idle;
  const bump=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(),idleMs);idle.unref?.();};
  const stop=()=>{clearTimeout(idle);release?.();};
  const fail=(c,error)=>{void reader.cancel().catch(()=>{});stop();c.error(error);};
  return new ReadableStream({
    start(){reader=source.getReader();controller.signal.addEventListener('abort',()=>{void reader.cancel('aborted').catch(()=>{});},{once:true});bump();},
    async pull(c){
      try {
        const {done,value}=await reader.read();
        if(controller.signal.aborted)return fail(c,new Error('request_aborted'));
        if(done){
          if(tail.length)c.enqueue(new Uint8Array(tail));
          if(keep&&kept<=limit&&typeof onObservation==='function'){
            const observation=observe({body:Buffer.concat(keep).toString('utf8'),contentType});
            if(observation)await onObservation(observation);
          }
          stop();c.close();return;
        }
        bump();
        const chunk=Buffer.from(value);total+=chunk.byteLength;
        if(total>limit)return fail(c,new Error('payload_too_large'));
        if(keep&&kept<=limit){keep.push(chunk);kept+=chunk.byteLength;}
        const window=Buffer.concat([tail,chunk]);
        if(needle&&window.includes(needle))return fail(c,new Error('invalid_provider_response'));
        const release_=Math.max(0,window.length-Math.max(0,hold-1));
        tail=window.subarray(release_);
        if(release_>0)c.enqueue(new Uint8Array(window.subarray(0,release_)));
      }catch(error){fail(c,error);}
    },
    cancel(reason){clearTimeout(idle);void reader.cancel(reason).catch(()=>{});stop();},
  });
}
// One finite JSON request, no redirects or retries. Binding comes exclusively
// from the broker. Remote cancellation is never promoted to compute cessation.
export function createAccountTransport({fetch:send=globalThis.fetch,timeoutMs=60000,maxBytes=16*1024*1024}={}) {
  const streams=new Map();
  return {
    async dispatch({request,signal,binding,authorizeSend,observeResponse,onObservation}) {
      const controller=new AbortController(),streamId=randomUUID();let streaming=false;
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(abort,timeoutMs);timer.unref?.();
      const release=()=>{streams.delete(streamId);clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      try {
        const stream=request.body.kind==='empty'?null:request.body.kind==='replayable'?request.body.open():request.body.stream;
        const bytes=await boundedBytes(stream,1024*1024,AbortSignal.any([controller.signal,...(signal?[signal]:[])]));
        const payload=JSON.parse(bytes.toString('utf8'));
        const efforts=[payload.reasoning?.effort,payload.output_config?.effort,payload.reasoning_effort,payload.effort].filter(value=>value!==undefined);
        if(payload.model!==binding.selection.modelId||efforts.some(value=>value!==binding.selection.effortId)||
          (binding.selection.effortId!==null&&efforts.length===0))
          return fault('job_binding_mismatch');
        if(streams.size>=256)return fault('account_busy');
        if(typeof authorizeSend!=='function')return fault('authority_unavailable');
        streams.set(streamId,{keyId:binding.keyId,controller});
        // Bound the final authority read too. A late verifier cannot send:
        // the thunk below rechecks this controller's timeout/abort signal.
        const effect=()=>{
          // The body read and the authority read may each outlive cancellation.
          controller.signal.throwIfAborted();signal?.throwIfAborted();
          return send(request.url,{method:request.method,headers:request.headers,body:bytes,
            signal:AbortSignal.any([controller.signal,...(signal?[signal]:[])]),redirect:'error'});
        };
        const authorized=await new Promise((resolve,reject)=>{
          const stopped=()=>reject(new Error('authorization_aborted'));
          if(controller.signal.aborted){stopped();return;}
          controller.signal.addEventListener('abort',stopped,{once:true});
          Promise.resolve().then(()=>authorizeSend(effect)).then(resolve,reject)
            .finally(()=>controller.signal.removeEventListener('abort',stopped)).catch(()=>{});
        });
        if(!authorized?.ok)return authorized??fault('authority_unavailable');
        const response=authorized.value;
        const secret=request.headers.authorization?.replace(/^Bearer /,'');
        // Provider headers (cookies, auth challenges, redirects) are never reflected. The body is streamed:
        // bytes are held back by the secret's length so none of the host credential can reach the guest, a total
        // bound applies, and the served-model observation is taken from the full body when the stream ends.
        const body=response.body?streamingBody(response.body,{secret,limit:maxBytes,controller,
          observe:response.ok&&typeof observeResponse==='function'?observeResponse:null,release,
          contentType:response.headers.get('content-type')??'',onObservation}):null;
        streaming=body!==null;
        if(body)clearTimeout(timer); // the whole-request bound ends at the reply; streaming has idle, size and key bounds
        return ok({streamId,observation:null,response:new Response(body,{status:response.status,
          headers:{'content-type':response.headers.get('content-type')??'application/json'}})});
      }catch{return fault(signal?.aborted?'request_aborted':'auth_temporarily_unavailable');}
      finally{if(!streaming)release();}
    },
    async revokeStreams({keyId}) {
      const unconfirmed=[];
      for(const [id,entry] of streams)if(entry.keyId===keyId){entry.controller.abort();unconfirmed.push(id);}
      return {aborted:[],unconfirmed};
    },
  };
}

// A job key is the only authentication accepted on this route. The local app
// session cannot authorize a provider call. No arbitrary URL is guest supplied.
// One handler serves every guest route (the app listener and the sandbox tunnel).
export function createAccountProxyHandler({providers,broker}) {
  return async function handle({method,url,headers,body,signal,expectedProviderId}) {
    const m=/^\/api\/account-proxy\/([^/?]+)/.exec(url);
    if(!m)return {status:404,headers:{},body:null};
    const providerId=decodeURIComponent(m[1]);
    if(expectedProviderId&&providerId!==expectedProviderId)return {status:403,headers:{'content-type':'application/json'},body:JSON.stringify({code:'job_binding_mismatch'})};
    const found=providers.getProvider(providerId);
    if(!found.ok)return {status:404,headers:{},body:null};
    const destination=found.value.descriptor.destinations[0];
    const endpoint=new URL(url,'http://local');
    const prefix='/api/account-proxy/'+encodeURIComponent(providerId);
    const suffix=endpoint.pathname.slice(prefix.length)||'/';
    const target=new URL(found.value.proxyRequestUrl?.(suffix)??new URL(destination.pathPrefixes[0].replace(/\/$/,'')+suffix,destination.origin).href);
    const key=String(headers.authorization??'').replace(/^Bearer /,'');
    let size=0;
    const limited=body.pipeThrough(new TransformStream({transform(chunk,controller){
      size+=chunk.byteLength;if(size>1024*1024)throw Error('payload_too_large');controller.enqueue(chunk);
    }}));
    const result=await broker.proxy.dispatch({key,signal,request:{method,url:target.href,
      headers:{...headers,'x-faravan-provider-id':providerId},
      body:{kind:'one_shot',stream:limited,dispose:async()=>{if(!limited.locked)await limited.cancel().catch(()=>{});}}}});
    if(!result.ok)return {status:403,headers:{'content-type':'application/json'},body:JSON.stringify({code:result.error.code})};
    const response=result.value.response;
    return {status:response.status,headers:{'content-type':response.headers.get('content-type')??'application/json'},body:response.body};
  };
}

export async function serveAccountProxy({req,res,providerId,providers,broker}) {
  const signal=new AbortController();req.once('aborted',()=>signal.abort());
  res.once('close',()=>{if(!res.writableEnded)signal.abort();});
  const reply=await createAccountProxyHandler({providers,broker})({method:req.method,url:req.url,headers:req.headers,
    body:Readable.toWeb(req),signal:signal.signal,expectedProviderId:providerId});
  res.writeHead(reply.status,reply.headers);
  if(reply.body==null||typeof reply.body==='string'){res.end(reply.body??undefined);return;}
  try {for await(const chunk of reply.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}res.end();}
  catch{res.destroy();}
}
