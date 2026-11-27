import fs from 'node:fs';
import {join,relative,sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {barrier} from './crash-process.mjs';

// A deliberately weak filesystem: only synced file contents and synced directory
// entries survive reboot. SIGKILL alone would retain the real kernel's dirty pages.
const [root,scenario,modulePath]=process.argv.slice(2);
const directory=join(root,'settings'),target=join(directory,'owner-settings.json');
const files=new Map(),directories=new Map();
const inode=stat=>`${stat.dev}:${stat.ino}`;
function persist(path) {
  // Parent-directory barriers are outside this synthetic reboot model. Never
  // enumerate the developer's home or other real ancestors of the test root.
  if(path!==root&&!path.startsWith(root+sep))return;
  const stat=fs.statSync(path),key=inode(stat);
  if(stat.isDirectory())directories.set(key,fs.readdirSync(path).map(name=>{
    const child=fs.statSync(join(path,name));return {name,key:inode(child),directory:child.isDirectory()};
  }));
  else files.set(key,fs.readFileSync(path).toString('base64'));
}
if(!['first','precreated'].includes(scenario)) {
  fs.mkdirSync(directory);
  fs.writeFileSync(target,JSON.stringify({version:1,values:{maxJobUsd:scenario==='migration'?1:9,
    ...(scenario==='migration'?{weeklyOverrunPoints:0.1,shortOverrunPoints:0.1}:{})},audit:[]}));
  persist(target);persist(directory);
}
persist(root);
if(scenario==='precreated')fs.mkdirSync(directory);
const rootKey=inode(fs.statSync(root));
const open=fs.openSync,sync=fs.fsyncSync,descriptors=new Map();
fs.openSync=(path,...args)=>{const fd=open(path,...args);descriptors.set(fd,String(path));return fd;};
fs.fsyncSync=fd=>{sync(fd);persist(descriptors.get(fd));};
syncBuiltinESMExports();
const {createOwnerSettings}=await import(modulePath??'../../lib/v1/owner-settings.mjs');
const settings=createOwnerSettings({directory,now:()=>1});
if(scenario!=='migration')settings.set({by:'owner',reason:'lower limit',now:1,maxJobUsd:1});
const stable={};
function visit(key,path) {
  for(const entry of directories.get(key)??[]) {
    const child=join(path,entry.name);
    if(entry.directory)visit(entry.key,child);
    else stable[relative(root,child)]=files.get(entry.key)??'';
  }
}
visit(rootKey,root);
fs.writeFileSync(join(root,'stable.json'),JSON.stringify(stable));
await barrier('cap-ack','cap-ack');
