import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {parseAst} from 'rollup/parseAst';

function violations(source, file) {
  const js=file.endsWith('.jsx')?transformSync(source,{loader:'jsx',jsx:'automatic',jsxImportSource:'preact'}).code:source;
  const ast=parseAst(js), findings=[];
  const rawMessage=node=>node?.type==='MemberExpression'&&node.object?.type==='Identifier'&&
    /^(?:error|err|e|problem|refusal|agentRefusal)$/i.test(node.object.name)&&
    (node.computed?node.property?.value:node.property?.name)==='message';
  function walk(node) {
    if(!node||typeof node!=='object')return;
    if(rawMessage(node))findings.push(file+': raw failure message');
    if(node.type==='TemplateLiteral'||node.type==='BinaryExpression'&&node.operator==='+') {
      const text=js.slice(node.start,node.end);
      if(/\b(?:error|err|problem)\??\.status\b/.test(text))findings.push(file+': transport status in copy');
    }
    for(const [key,value] of Object.entries(node)) {
      if(['start','end','loc'].includes(key))continue;
      if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
    }
  }
  walk(ast);return findings;
}

test('ordinary UI cannot render free-form failure messages or interpolate transport status',()=>{
  const dir=new URL('.',import.meta.url);
  const files=readdirSync(dir).filter(name=>/\.(jsx|mjs)$/.test(name)&&!name.includes('.test.')&&!name.includes('test-helper')&&!['api.mjs','transcript-feed.mjs'].includes(name));
  const found=files.flatMap(file=>violations(readFileSync(new URL(file,dir),'utf8'),file));
  assert.deepEqual(found,[]);
});

test('the architecture guard catches optional/computed messages and status templates',()=>{
  assert.ok(violations('export const a=error?.message;','a.jsx').length);
  assert.ok(violations('export const a=err["message"];','a.jsx').length);
  assert.ok(violations('export const a=`error ${error.status}`;','a.jsx').length);
  assert.deepEqual(violations('export const a=errorMessage(error);','a.jsx'),[]);
});
