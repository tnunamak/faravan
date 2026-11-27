import {parse} from 'acorn';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative} from 'node:path';
const root=new URL('../../',import.meta.url);
export function accountAwaitInventory(){
 const inventory=new Map();
 function add(url){
  if(inventory.has(url.href)||!url.href.startsWith(root.href)||!/\.[cm]?js$/.test(url.pathname))return;
  const source=readFileSync(url,'utf8'),file=relative(fileURLToPath(root),fileURLToPath(url));
  const entry={url:url.href,file,source,...instrumentAwaits(source,file)};inventory.set(url.href,entry);
  for(const specifier of entry.imports)if(specifier.startsWith('.'))add(new URL(specifier,url));
 }
 add(new URL('lib/docker-backend.mjs',root));
 // The app supplies this implementation to the backend rather than importing it from the backend.
 add(new URL('lib/disk-ledger.mjs',root));
 add(new URL('lib/disk-sweep-setting.mjs',root));
 return [...inventory.values()];
}
// All local transitive imports participate, including literal dynamic imports. Unknown runtime imports fail the
// loader's inventory check. The daemon gate has separate real-control-transport regressions; this inventory covers all asynchronous job preparation adapters.
export function instrumentAwaits(source,file){
 const tree=parse(source,{ecmaVersion:'latest',sourceType:'module',locations:true,allowReturnOutsideFunction:true}),sites=[],calls=[],edits=[],imports=[];let totalAwaits=0;
 function visit(node,scope='module'){
  if(!node||typeof node!=='object')return;
  if(['ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration','ImportExpression'].includes(node.type)&&typeof node.source?.value==='string')imports.push(node.source.value);
  if(node.type==='AwaitExpression'||node.type==='ForOfStatement'&&node.await)totalAwaits++;
  if(node.type==='FunctionDeclaration')scope=node.id?.name??scope;
  if(node.type==='MethodDefinition')scope=node.key.name;
  if(node.type==='VariableDeclarator'&&['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type))scope=node.id.name;
  if(node.type==='AssignmentExpression'&&node.left.type==='Identifier'&&node.right.type==='ArrowFunctionExpression')scope=node.left.name;
  if(node.type==='AwaitExpression'){
   const expression=source.slice(node.argument.start,node.argument.end).replace(/\s+/g,' '),id=file+':'+scope+':'+sites.filter(s=>s.scope===scope).length;
   sites.push({id,scope,file,line:node.loc.start.line,expression});
   edits.push({at:node.argument.start,text:`globalThis.__accountAwaitPause(${JSON.stringify(id)},async()=> (`});
   edits.push({at:node.argument.end,text:'))'});
  }
  if(node.type==='CallExpression'){
   if(node.callee.type==='Identifier'&&node.callee.name==='require'&&typeof node.arguments[0]?.value==='string')imports.push(node.arguments[0].value);
   const member=node.callee.type==='MemberExpression'&&node.callee.object.type==='ThisExpression'&&node.callee.property.name==='runSbx';
   const stream=node.callee.type==='Identifier'&&node.callee.name==='runSbxStreaming';
   const output=node.callee.type==='Identifier'&&node.callee.name==='spawnSbxChild'&&scope==='streamSbxOutput';
   if(member||stream||output){
    const id=file+':'+scope+':call'+calls.filter(s=>s.scope===scope).length;
    calls.push({id,scope,file,line:node.loc.start.line});
    const replacement=member?`globalThis.__accountSpawnTest.call.bind(null,this,${JSON.stringify(id)})`:stream?`globalThis.__accountSpawnTest.stream.bind(null,runSbxStreaming,${JSON.stringify(id)})`:`globalThis.__accountSpawnTest.output.bind(null,spawnSbxChild,${JSON.stringify(id)})`;
    edits.push({at:node.callee.start,text:replacement,end:node.callee.end});
   }
  }
  for(const [key,value] of Object.entries(node))if(key!=='loc'){
   if(Array.isArray(value)){for(const child of value)visit(child,scope);}else if(value&&typeof value==='object')visit(value,scope);
  }
 }
 visit(tree);
 for(const edit of edits.sort((a,b)=>b.at-a.at||(b.end??b.at)-(a.end??a.at)))source=source.slice(0,edit.at)+edit.text+source.slice(edit.end??edit.at);
 return {source,sites,calls,totalAwaits,imports};
}
