import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {OPS,offeredOnMcp} from '../lib/v1/ops/registry.mjs';
import {runAccountsCommand} from '../lib/v1/accounts-cli.mjs';

async function files(dir,out=[]){
  let names;try{names=await readdir(dir);}catch{return out;}
  for(const name of names){const path=join(dir,name),stat=await lstat(path);if(stat.isDirectory())await files(path,out);else if(stat.isFile())out.push(path);}
  return out;
}

test('an added Claude token appears on no app read surface, MCP read tool or telemetry file',{timeout:60000},async t=>{
  const sbx=await mkdtemp(join(tmpdir(),'faravan-account-sbx-')),old=process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME=sbx;
  t.after(async()=>{if(old===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=old;await rm(sbx,{recursive:true,force:true});});
  const f=await appFixture(t);
  const {app,home}=await f.start('owner');
  const unique='sk-ant-oat01-'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  let added='';
  await runAccountsCommand(['add','claude','--label','Surface'],{home,stdin:Readable.from([unique]),stdout:{write:text=>added+=text}});
  assert.equal(added.includes(unique),false);
  // Every MCP-offered read that maps to a plain GET is the same HTTP read the MCP tool makes.
  const reads=OPS.filter(op=>offeredOnMcp(op)&&op.safety==='read'&&op.rest?.method==='GET'&&!op.rest.path.includes(':'));
  assert.ok(reads.some(op=>op.id==='status.get'));
  const bodies=[];
  for(const op of reads){
    const response=await fetch(app.origin+op.rest.path,{headers:{'x-faravan-session-token':app.token},signal:AbortSignal.timeout(10000)}).catch(()=>null);
    if(response)bodies.push(op.id+' '+response.status+' '+await response.text());
  }
  assert.ok(bodies.filter(body=>/^\S+ 200 /.test(body)).length>=5,'read surfaces answered')
  for(const body of bodies)assert.equal(body.includes(unique),false,body.slice(0,80));
  const status=await api(app,'/api/status');assert.equal(JSON.stringify(status).includes(unique),false);
  // Only the private generation file under the sbx home holds the value; nothing in the app home (settings,
  // logs, telemetry spool, account registry) does.
  const holders=[];
  for(const path of [...await files(home),...await files(sbx)])if((await readFile(path)).includes(unique))holders.push(path);
  assert.equal(holders.length,1,holders.join(','));
  assert.match(holders[0],/credential-generations\/[0-9a-f-]+\/value$/);
});
