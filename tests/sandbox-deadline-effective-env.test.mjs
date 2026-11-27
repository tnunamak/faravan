import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createSandboxDeadlineManager} from '../lib/sandbox-deadline.mjs';
test('effective removal environment excludes imported manager provider variables',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-env-'));let child;t.after(()=>{child?.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});});
 const binary=path.join(root,'fake-sbx'),observed=path.join(root,'observed.json');
 fs.writeFileSync(binary,'#!'+process.execPath+'\nimport fs from "node:fs";if(process.argv[2]==="rm")fs.writeFileSync('+JSON.stringify(observed)+',JSON.stringify({args:process.argv.slice(2),env:process.env}));else console.log("[]");',{mode:0o755});
 const row={sandbox_id:'dl-0123456789abcdef',sbx_home:root,deadline_at:Date.now()+2000};fs.writeFileSync(path.join(root,row.sandbox_id+'.json'),JSON.stringify({...row,create:'dispatched',compute_created:true,create_settled:true}));
 let argv,armed=false;
 const manager=createSandboxDeadlineManager({binary,directory:root,platform:'linux',run:async(command,args)=>{
  const ok={code:0,stdout:''};if(command==='systemd-run'){argv=args.slice(args.indexOf('--')+1);child=spawn(argv[0],argv.slice(1),{env:{PATH:'/usr/bin:/bin',HOME:root,FAKE_IMPORTED_PROVIDER:'synthetic-only'},stdio:'ignore'});armed=true;return ok;}
  if(command==='systemctl')return {...ok,code:args.includes('is-active')&&!armed?1:0};
  return {...ok,stdout:JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/fixture']:[[argv[0],argv,false,0,0,0,0,0,0,0]]})};
 }});
 await manager.register(row);await once(child,'exit');child=null;
 const effective=JSON.parse(fs.readFileSync(observed));assert.deepEqual(effective.args,['rm','--force',row.sandbox_id]);assert.deepEqual(effective.env,{HOME:root});
});
