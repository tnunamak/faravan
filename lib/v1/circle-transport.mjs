import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';

// One connection/session pool per app, rather than one per short-lived signed client.
// This caches transport resources only: every request still carries fresh authorization.
export function createCircleTransport() {
  const plain=new http.Agent({keepAlive:true,maxFreeSockets:8});
  const secure=new https.Agent({keepAlive:true,maxFreeSockets:8});
  return {
    fetch(input,{method='GET',headers,body,signal}={}) {
      const url=new URL(input);
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Invalid circle URL');
      return new Promise((resolve,reject)=>{
        const request=(url.protocol==='https:'?https:http).request(url,{
          method,headers,signal,agent:url.protocol==='https:'?secure:plain,
        },response=>{
          const empty=method==='HEAD'||[204,205,304].includes(response.statusCode);
          if(empty)response.resume();
          const values=new Headers();
          for(const [name,value] of Object.entries(response.headers))if(value!==undefined)
            for(const item of Array.isArray(value)?value:[value])values.append(name,item);
          resolve(new Response(empty?null:Readable.toWeb(response),{status:response.statusCode,headers:values}));
        });
        request.once('error',reject);
        request.end(body);
      });
    },
    close(){plain.destroy();secure.destroy();},
  };
}
