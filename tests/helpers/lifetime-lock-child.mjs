import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireProcessLock} from '../../lib/v1/lock.mjs';
import {AppLifetime} from '../../lib/v1/app-lifetime.mjs';
const home=process.argv[2];
await mkdir(join(home,'v1'),{recursive:true});
const owner=new AppLifetime({budgetMs:3});
const release=await acquireProcessLock(join(home,'v1','app.lock'),{timeoutMs:0});
owner.register('app lock','lock',{release});
owner.register('writer','producer',{drain:()=>new Promise(()=>{})});
const result=await owner.stop('quit');
process.send({state:result.state});
// Simulate process exit after an interrupted stop, without releasing its retained lock.
process.on('message',()=>process.exit(0));
