import fs from 'node:fs';
import {legacySandboxNameFor as testSandboxName} from '../../lib/sandbox-name.mjs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDevice} from '../../lib/v1/device.mjs';
import {provisionLocalCircle} from '../../lib/v1/host.mjs';
import {createCheckSandboxes} from '../../lib/v1/check-sandboxes.mjs';
import {barrier} from './crash-process.mjs';

const [directory,scenario,phase]=process.argv.slice(2);
if(scenario==='provision') {
  const device=await openDevice({home:join(directory,'device'),ensureDefault:false,origin:null});
  let circle;
  if(phase==='create') {
    circle=await device.createCircle('http://127.0.0.1:18787',{publish:false});
    fs.writeFileSync(join(directory,'circle.json'),JSON.stringify(circle));
    const dbPath=join(directory,'host','v1','coordinator.sqlite');fs.mkdirSync(join(directory,'host','v1'),{recursive:true});
    new DatabaseSync(dbPath).exec('CREATE TABLE circle (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await barrier('schema-created','schema-created');
  } else {
    circle=JSON.parse(fs.readFileSync(join(directory,'circle.json'),'utf8'));
    await provisionLocalCircle({home:join(directory,'host'),circle});
    fs.writeFileSync(join(directory,'provisioned'),'ok');
    await barrier('provisioned','provisioned');
  }
} else if(scenario==='check') {
  const file=join(directory,'checks.json'),inventory=join(directory,'inventory.json');
  const id='wf-pull-0000000000000000-01234567';
  const liveId='wf-pull-0000000000000000-89abcdef';
  let now=1000000;
  const backend={
    async prepare(job){
      const names=fs.existsSync(inventory)?JSON.parse(fs.readFileSync(inventory,'utf8')):['unowned'];
      const sandbox_id=testSandboxName(job.job_id);
      fs.writeFileSync(inventory,JSON.stringify([...names,sandbox_id]));
      return {job_id:job.job_id,sandbox_id,scratch_dir:null};
    },
    async runSbx(args){let names=JSON.parse(fs.readFileSync(inventory,'utf8'));if(args[0]==='rm'){names=names.filter(n=>n!==args[2]);fs.writeFileSync(inventory,JSON.stringify(names));}return {code:0,stdout:JSON.stringify(names.map(name=>({name})))};},
  };
  const checks=createCheckSandboxes({backend,file,now:()=>now,timeoutMs:250});
  if(phase==='create'){await checks.backend.prepare({job_id:id});await barrier('check-created','check-created');}
  else {
    await checks.backend.prepare({job_id:liveId});
    await checks.reap();
    const startup=JSON.parse(fs.readFileSync(inventory,'utf8'));
    const expiresAt=JSON.parse(fs.readFileSync(file,'utf8')).find(row=>row.job_id===id).expires_at;
    fs.writeFileSync(join(directory,'startup.json'),JSON.stringify({names:startup,now,expiresAt}));
    now=expiresAt+1;
    checks.startReaper?.({intervalMs:25});
    // Only the recurring worker can forget a lease after the clock advances.
    // A real-time deadline bounds the failing control; it does not set expiry.
    await new Promise(resolve=>{
      const timeout=setTimeout(()=>{clearInterval(poll);resolve();},5000);
      const poll=setInterval(()=>{
        if(JSON.parse(fs.readFileSync(file,'utf8')).some(row=>row.job_id===id))return;
        clearInterval(poll);clearTimeout(timeout);resolve();
      },25);
    });
    await checks.close?.();
    fs.writeFileSync(join(directory,'remaining.json'),JSON.stringify({names:JSON.parse(fs.readFileSync(inventory,'utf8')),now,
      journal:JSON.parse(fs.readFileSync(file,'utf8'))}));
    await barrier('check-recovered','check-recovered');
  }
}
