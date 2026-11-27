import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

for(const budget of [500,1000])test('blocked privileged probe is killed and reaped with '+budget+' ms budget',{timeout:6000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'credential-deadline-'));
 const home=join(root,'home'),scan=join(root,'scan'),proc=join(root,'proc'),bin=join(root,'bin'),trace=join(root,'pids.jsonl'),driver=join(root,'driver.mjs');
 for(const dir of [home,scan,proc,bin])await mkdir(dir);
 await writeFile(join(scan,'blocked.txt'),'ordinary text');
 const module=new URL('../lib/v1/credential-probe-guest.mjs',import.meta.url).href;
 await writeFile(driver,`
 import fs from 'node:fs';
 import {syncBuiltinESMExports} from 'node:module';
 import {runProbeWithDeadline} from ${JSON.stringify(module)};
 const args=process.argv.slice(2),root=args.includes('root');
 const deadline=args.indexOf('--deadline-ns');
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,root,deadline:deadline<0?null:args[deadline+1]})+'\\n');
 if(root){const read=fs.readSync;fs.readSync=(...args)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return read(...args);};syncBuiltinESMExports();}
 const report=await runProbeWithDeadline({role:root?'root':'user',home:${JSON.stringify(home)},roots:[[${JSON.stringify(scan)},1]],proc:${JSON.stringify(proc)},mountsText:'',env:{HOME:${JSON.stringify(home)},SBX_CRED_OPENAI_MODE:'oauth',GH_TOKEN:'proxy-managed'},provider:'openai',networkChecks:['ssh-agent','mcp-gateway','link-local-metadata'].map(id=>({id,found:false,severity:'none',evidence_redacted:'synthetic'})),budgetMs:${budget},sudoCandidates:[${JSON.stringify(join(bin,'sudo'))}],...(deadline<0?{}:{deadlineNs:args[deadline+1]})});
 process.stdout.write(JSON.stringify(report));
 `);
 // Replaces sudo with an unprivileged exec of the controlled driver. No real
 // privileged scan or host credential path is used.
 await writeFile(join(bin,'sudo'),'#!/bin/sh\nif [ "$2" = true ]; then exit 0; fi\nexec '+"'"+process.execPath+"' '"+driver+"' \"$@\"\n");
 await chmod(join(bin,'sudo'),0o755);
 const child=spawn(process.execPath,[driver],{env:process.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  const rows=(await readFile(trace,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
  for(const row of rows){const cmd=await readFile('/proc/'+row.pid+'/cmdline','utf8').catch(()=>'');if(cmd.includes(driver))try{process.kill(row.pid,'SIGKILL');}catch{}}
  await rm(root,{recursive:true,force:true});
 });
 const began=performance.now();
 const [code,signal]=await new Promise(resolve=>child.once('close',(...result)=>resolve(result)));
 const elapsed=performance.now()-began;
 assert.equal(code,0,stderr+' signal='+signal);
 assert.equal(JSON.parse(stdout).verdict,'inconclusive');
 const rows=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(rows.some(row=>row.root),'the controlled privileged worker actually started');
 for(const row of rows.filter(row=>row.root))assert.match(row.deadline??'',/^\d+$/,'the privileged worker received the absolute parent deadline');
 for(const row of rows)assert.throws(()=>process.kill(row.pid,0),{code:'ESRCH'},'worker '+row.pid+' was reaped');
 t.diagnostic('parent '+budget+' ms work budget; blocked privileged fixture completed and reaped in '+elapsed.toFixed(1)+' ms');
});
