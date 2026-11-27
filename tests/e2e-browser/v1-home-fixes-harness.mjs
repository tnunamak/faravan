// Disposable, loopback-only first-circle journey. Never touches the user's services or agent stores.
import {createServer} from 'node:net';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,syntheticBackend} from '../helpers/v1-app-fixture.mjs';
import {hostCommand} from '../../lib/v1/host-command.mjs';
const cleanups=[];
const f=await appFixture({after:fn=>cleanups.push(fn)},{});
const home=await f.home('owner'), coordinatorHome=join(f.root,'home-fixes-host');
const port=await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
const guard=join(f.root,'loopback-only.cjs');
await writeFile(guard,`
const net=require('node:net'),os=require('node:os');
os.networkInterfaces=()=>({test:[{family:'IPv4',internal:false,address:'127.0.0.1'}]});
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{host:typeof values[1]==='string'?values[1]:'localhost'};
if(!options.path&&!['127.0.0.1','::1','localhost'].includes(options.host??'localhost'))throw new Error('Non-loopback connection refused in home-fixes test');return connect.apply(this,args);};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){if(typeof args[0]==='object')args[0]={...args[0],host:'127.0.0.1'};else if(typeof args[0]==='number'){if(typeof args[1]==='string')args[1]='127.0.0.1';else args.splice(1,0,'127.0.0.1');}return listen.apply(this,args);};
`);
process.env.NODE_OPTIONS=(process.env.NODE_OPTIONS??'')+' --require '+JSON.stringify(guard);
const backend=syntheticBackend(f.root,{});
backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});
const owner=await f.start('owner',{coordinatorHome,userHome:home,backend,pollMs:250,approvalPollMs:1500,hostProfileMs:1000});
await mkdir(join(home,'sandbox'),{recursive:true});
await owner.app.device.setOwnerName('Tessa');
console.log(JSON.stringify({owner:owner.app.origin,token:owner.app.token,port,home}));
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  try{await hostCommand({home,coordinatorHome},['--stop'],'host_stopped').catch(()=>{});}
  finally{for(const cleanup of cleanups.reverse())await cleanup();process.exit(0);}
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
