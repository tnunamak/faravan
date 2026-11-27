import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:net';

// Fakes for the Codex redirect-paste tests: a login CLI that names its own localhost listener.
export const freePort=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
export const STATE='state-abc123';
export const CODE='ac_synthetic_code';

// A fake codex CLI: prints a login URL naming its own localhost listener, exits 0 only for the right code and state.
export async function fakeCodex(home,port,{provider='codex',listen=true}={}) {
  const log=join(home,'requests.log'),bin=join(home,provider);
  const redirect='http://localhost:'+port+'/auth/callback';
  await writeFile(bin,'#!'+process.execPath+'\n'+`
    const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
    const server=http.createServer((req,res)=>{
      fs.appendFileSync(${JSON.stringify(log)},req.url+'\\n');
      const u=new URL(req.url,'http://x');
      const ok=u.pathname==='/auth/callback'&&u.searchParams.get('code')===${JSON.stringify(CODE)}&&u.searchParams.get('state')===${JSON.stringify(STATE)};
      res.end('done');
      if(ok){fs.writeFileSync(path.join(process.env.HOME,'auth.json'),JSON.stringify({tokens:{access_token:'a',id_token:'i',refresh_token:'r'}}),{mode:0o600});server.close();process.exit(0);}
      else process.exit(1);
    });
    const announce=()=>console.log('https://${provider==='codex'?'auth.openai.com':'claude.ai'}/oauth/authorize?response_type=code&redirect_uri='+encodeURIComponent(${JSON.stringify(redirect)})+'&state=${STATE}');
    ${listen?`server.listen(${port},'127.0.0.1',announce);`:'announce();setInterval(()=>{},1000);'}
  `,{mode:0o700});
  return {bin,log,port};
}

export const DEVICE_CODE='ABCD-EFGHI';
export const DEVICE_TEXT=`Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   ${DEVICE_CODE}
`;
// What the real CLI prints through a pipe (codex 0.152.1 on Mac and 0.167.1 on Linux, captured by the ship lane; the code here is
// a fake one): the link is wrapped as ESC[94m<link>ESC[0m, the expiry as ESC[90m...ESC[0m, the code as ESC[94m<code>ESC[0m.
const ESC='\u001b';
export const DEVICE_TEXT_COLORED=
`Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m

2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m
   ${ESC}[94m${DEVICE_CODE}${ESC}[0m
`;
// A fake codex CLI for `login --device-auth`. mode 'approve': prints the steps, waits, signs in, exits 0.
// 'refused': the code request fails with HTTP `status`. 'exchange': the code is shown, then the exchange fails.
// 'expired': the code is shown, then the CLI says it expired. color false prints the plain text. helpLink prints a
// help link before the steps. readyDelayMs holds the steps back. expires changes the "expires in N minutes" text.
// Every call logs its arguments; a call without --device-auth is logged as a browser login and ends at once.
export async function fakeCodexDevice(home,{mode='approve',waitMs=400,status=403,color=true,helpLink=false,readyDelayMs=0,expires=15,raw=null,splitAt=[]}={}) {
  const argsLog=join(home,'args.log'),bin=join(home,'codex');
  const text=raw??(color?DEVICE_TEXT_COLORED:DEVICE_TEXT).replace('expires in 15 minutes','expires in '+expires+' minutes');
  const cuts=[0,...splitAt,text.length],pieces=cuts.slice(0,-1).map((c,i)=>text.slice(c,cuts[i+1]));
  await writeFile(bin,'#!'+process.execPath+'\n'+`
    const fs=require('node:fs'),path=require('node:path');
    fs.appendFileSync(${JSON.stringify(argsLog)},process.argv.slice(2).join(' ')+'\\n');
    if(!process.argv.includes('--device-auth')){console.error('browser login');process.exit(1);}
    if(${JSON.stringify(mode)}==='refused'){console.error('Error logging in: failed to request device code: device code request failed with status '+${JSON.stringify(status)});process.exit(1);}
    ${helpLink?"console.log('Need help? https://help.openai.com/en/articles/codex-login');":''}
    setTimeout(()=>{
      const pieces=${JSON.stringify(pieces)};
      let i=0;const next=()=>{if(i<pieces.length){process.stdout.write(pieces[i++]);return setTimeout(next,80);}process.stdout.write('\\n');done();};
      const done=()=>setTimeout(()=>{
        if(${JSON.stringify(mode)}==='exchange'){console.error('device code exchange failed: denied');process.exit(1);}
        if(${JSON.stringify(mode)}==='expired'){console.error('Error: the device code has expired');process.exit(1);}
        fs.writeFileSync(path.join(process.env.HOME,'auth.json'),JSON.stringify({tokens:{access_token:'a',id_token:'i',refresh_token:'r'}}),{mode:0o600});
        process.exit(0);
      },${waitMs});
      next();
    },${readyDelayMs});
  `,{mode:0o700});
  return {bin,argsLog};
}
