import './no-browser.mjs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {appFixture,api} from './v1-app-fixture.mjs';
import {instant,json} from './v1-journey.mjs';
export async function startResultProcesses(){
 const cleanup=[],children=[];const f=await appFixture({after:fn=>cleanup.push(fn)});
 const appOverride=f.override;
 f.override=async context=>{
  const {route,res}=context;
  if(route==='/presence'){json(res,{now:instant(),online_seconds:90,devices:[],persons:[]});return true;}
  return appOverride?appOverride(context):false;
 };
 const stop=async()=>{for(const child of children.reverse())if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}for(const fn of cleanup.reverse())await fn();};
 try {
  await f.provisionFromHome('owner');await mkdir(join(f.root,'projects','sandbox'),{recursive:true});
  const folder=join(f.root,'projects','sandbox');
  for(const [path,text] of Object.entries({'notes.txt':'old\n','keep.txt':'keep\n','delete.txt':'gone\n'}))await writeFile(join(folder,path),text);
  const start=async name=>{
   const isolatedHome=join(f.root,name+'-process-home'),appHome=await f.home(name);
   const codexHome=join(isolatedHome,'.codex'),claudeHome=join(isolatedHome,'.claude');
   await Promise.all([mkdir(codexHome,{recursive:true}),mkdir(claudeHome,{recursive:true})]);
   const child=fork(fileURLToPath(new URL('./result-process-app.mjs',import.meta.url)),[JSON.stringify({home:appHome,root:f.root,name})],{
    stdio:['ignore','ignore','inherit','ipc'],
    env:{...process.env,HOME:isolatedHome,FARAVAN_HOME:appHome,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,
     DISPLAY:'',WAYLAND_DISPLAY:'',FARAVAN_NO_BROWSER:'1'},
   });
   children.push(child);
   return await Promise.race([once(child,'message').then(([app])=>({app})),once(child,'exit').then(([code])=>{throw new Error('Result app process exited: '+code);})]);
  };
  const owner=await start('owner'),lender=await start('lender');
  await api(owner.app,'/api/devices',{method:'POST',body:{name:'sandpiper',ownerName:'Alex Example'}});
  await api(lender.app,'/api/devices',{method:'POST',body:{name:'kestrel',ownerName:'Maya Okafor'}});
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Weekend projects'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  return {owner,lender,circle,folder,stop,coordinatorPid:process.pid};
 }catch(error){await stop();throw error;}
}
