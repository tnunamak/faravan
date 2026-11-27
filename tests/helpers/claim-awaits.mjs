import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';

const require=createRequire(import.meta.url);
const {babelParse,traverse}=require(join(dirname(require.resolve('playwright/package.json')),'lib/transform/babelBundle.js'));
const context=new AsyncLocalStorage();
export const withClaimAwaits=(value,run)=>context.run(value,run);
export async function claimAwait(label,read){
  const current=context.getStore();
  const promise=read();
  current?.boundary(label,'pending');
  try{
    const value=await promise;
    current?.boundary(label,'resume');
    return value;
  }catch(error){current?.boundary(label,'reject');throw error;}
}

export async function instrumentLender(t){
  const file=new URL('../../lib/v1/lender.mjs',import.meta.url);
  let source=readFileSync(file,'utf8');
  const ast=babelParse(source,'lender.mjs',true),edits=[];
  traverse(ast,{
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(path){
      const node=path.node.source;
      if(!node)return;
      if(node.value.startsWith('.'))edits.push([node.start,node.end,JSON.stringify(new URL(node.value,file).href)]);
    },
    AwaitExpression(path){
      const node=path.node,arg=source.slice(node.argument.start,node.argument.end);
      // The final availability await itself and the request are not application waits between proof and send.
      if(/^freshClaimBlocker\(/.test(arg)||/^backend\.lenderCapabilities\(/.test(arg)||/^observePoll\(\(\)=>client\.claim/.test(arg))return;
      const label=`L:${node.loc.start.line} ${arg.replace(/\s+/g,' ').slice(0,85)}`;
      edits.push([node.start,node.start+5,`await __claimAwait(${JSON.stringify(label)},async()=> (`]);
      edits.push([node.end,node.end,'))']);
    },
  });
  for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]||b[1]-a[1]))source=source.slice(0,start)+text+source.slice(end);
  source=`import {claimAwait as __claimAwait} from ${JSON.stringify(import.meta.url)};\n`+source;
  const directory=await mkdtemp(join(tmpdir(),'claim-awaits-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const target=join(directory,'lender.mjs');await writeFile(target,source);
  return (await import(pathToFileURL(target))).createLender;
}
