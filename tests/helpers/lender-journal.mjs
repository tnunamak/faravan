import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {babelParse,traverse}=require(join(dirname(require.resolve('playwright/package.json')),'lib/transform/babelBundle.js'));

// Observe the real journal and queue a real serialized write without adding a production testing API.
export async function journalLender(t){
  const file=new URL('../../lib/v1/lender.mjs',import.meta.url),source=readFileSync(file,'utf8');
  const ast=babelParse(source,'lender.mjs',true),edits=[];
  traverse(ast,{
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(path){
      const node=path.node.source;if(node?.value.startsWith('.'))edits.push([node.start,node.end,JSON.stringify(new URL(node.value,file).href)]);
    },
    ReturnStatement(path){
      const node=path.node.argument;
      if(node?.type==='ObjectExpression'&&node.properties.some(property=>property.key?.name==='start'))
        edits.push([node.start+1,node.start+1,'journalForTest:()=>counters, persistForTest:save,']);
    }
  });
  let instrumented=source;
  for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))instrumented=instrumented.slice(0,start)+text+instrumented.slice(end);
  const directory=await mkdtemp(join(tmpdir(),'lender-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const target=join(directory,'lender.mjs');await writeFile(target,instrumented);
  return (await import(pathToFileURL(target))).createLender;
}
