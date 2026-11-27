import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const processMethods=new Set(['exec','execSync','execFile','execFileSync','execFileCb','spawn','spawnSync','fork','execve']);
function walk(node,visit,ancestors=[]){if(!node||typeof node!=='object')return;visit(node,ancestors);for(const value of Object.values(node)){if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,visit,[...ancestors,node]);}else if(value?.type)walk(value,visit,[...ancestors,node]);}}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function executableSites(source,file){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true,locations:true});
 const aliases=new Set(),namespaces=new Set();
 walk(ast,node=>{if(node.type==='ImportDeclaration'&&/^(?:node:)?child_process$/.test(node.source.value))for(const spec of node.specifiers){if(spec.type==='ImportSpecifier'&&processMethods.has(spec.imported.name))aliases.add(spec.local.name);else namespaces.add(spec.local.name);}});
 const moduleReference=node=>node&&(node.type==='AwaitExpression'?moduleReference(node.argument):
  node.type==='ImportExpression'&&/^(?:node:)?child_process$/.test(node.source.value)||
  node.type==='CallExpression'&&node.callee.name==='require'&&/^(?:node:)?child_process$/.test(node.arguments[0]?.value));
 walk(ast,node=>{if(node.type==='VariableDeclarator'&&moduleReference(node.init)){
  if(node.id.type==='Identifier')namespaces.add(node.id.name);
  else if(node.id.type==='ObjectPattern')for(const property of node.id.properties)if(processMethods.has(property.key?.name??property.key?.value))aliases.add(property.value.name);
 }});
 const processReference=node=>node&&(node.type==='Identifier'&&(aliases.has(node.name)||/^(?:spawn(?:Process|Child|Impl)?|execFile(?:Async|Sync|Cb)?|execve)$/.test(node.name))||node.type==='MemberExpression'&&processMethods.has(node.property.name??node.property.value)&&
  (namespaces.has(node.object.name)||node.object.name==='process'||node.object.name==='primitives'));
 for(let changed=true;changed;){changed=false;walk(ast,node=>{
  const name=node.type==='VariableDeclarator'?node.id:node.type==='AssignmentPattern'?node.left:null;
  const value=node.type==='VariableDeclarator'?node.init:node.type==='AssignmentPattern'?node.right:null;
  if(name?.type==='Identifier'&&(processReference(value)||value?.type==='CallExpression'&&value.arguments.some(processReference))&&!aliases.has(name.name)){aliases.add(name.name);changed=true;}
 });}
 const boundary=file==='lib/docker-backend.mjs'?ast.body.find(node=>node.type==='ExportNamedDeclaration'&&node.declaration?.id?.name==='spawnSbxChild')?.declaration:null;
 const sites=[];
 walk(ast,(node,ancestors)=>{
  if(node.type!=='CallExpression')return;
  const delegated=node.arguments[0]?.value==='systemd-run'&&/owner\.executable|\bsbx\b|realSbx/.test(source.slice(node.arguments[1]?.start,node.arguments[1]?.end));
  const tagged=file==='lib/docker-backend.mjs'&&node.callee.name==='runCommand'&&node.arguments[2]?.type==='ObjectExpression'&&
   node.arguments[2].properties.some(property=>property.key?.name==='sbxDelegate'&&property.value?.type==='ObjectExpression');
  if(!processReference(node.callee)&&(!delegated||tagged))return;
  const fn=[...ancestors].reverse().find(n=>/Function|MethodDefinition/.test(n.type));
  const text=source.slice(node.start,node.end),body=fn?source.slice(fn.start,fn.end):text;
  const name=fn?.id?.name??[...ancestors].reverse().find(n=>n.type==='VariableDeclarator')?.id?.name??'anonymous';
  const qualified=boundary!==null&&fn===boundary;
  const target=node.callee.type==='Identifier'&&node.callee.name==='fork'?source.slice(node.arguments[0]?.start,node.arguments[0]?.end):node.arguments.slice(0,2).map(arg=>source.slice(arg.start,arg.end)).join(' ');
  const sbx=/\bsbx\b|FARAVAN_SBX_BIN|sbxBin|realSbx|loginBin|_claudeBinary|_sbxRuntime|owner\.executable/.test(target);
  sites.push({file,line:node.loc.start.line,scope:name,callee:source.slice(node.callee.start,node.callee.end),qualified,sbx,
   key:hash(file+'\0'+body+'\0'+text),expression:text});
 });
 // Shell/delegated execution cannot hide a new sbx launch from the JS call scan.
 walk(ast,node=>{if((node.type==='Literal'&&typeof node.value==='string'||node.type==='TemplateLiteral')&&/\b(?:exec|spawn|systemd-run|sh\s+-c)\b[^\n]*\bsbx\b/.test(source.slice(node.start,node.end))){
  const text=source.slice(node.start,node.end);sites.push({file,line:node.loc.start.line,scope:'embedded-command',callee:'embedded',qualified:false,sbx:true,key:hash(file+'\0'+text),expression:text});
 }});
 return sites;
}
export function unfencedSites(sites,nonSbx=[]){
 const exceptions=new Set(nonSbx.map(row=>row.key));
 return sites.filter(site=>!site.qualified&&(site.sbx||!exceptions.has(site.key)));
}
export function shellSbxSites(source,file){
 return source.split('\n').flatMap((line,index)=>{
  const text=line.trim();if(text.startsWith('#'))return [];
  const direct=/(?:^|[;&|]\s*|\bexec\s+)(?:env\s+)?(?:["']?[^\s;"']*\/)?["']?(?:sbx|\$\{?FARAVAN_SBX_BIN\}?)["']?(?:\s|$)/.test(text);
  const delegated=/\bsystemd-run\b.*\s(?:[^\s]*\/)?sbx(?:\s|$)/.test(text);
  const shell=/\b(?:sh|bash)\s+-c\s+["'](?:exec\s+)?(?:[^"']*\/)?sbx\b/.test(text);
  return direct||delegated||shell?[{file,line:index+1,expression:text}]:[];
 });
}
