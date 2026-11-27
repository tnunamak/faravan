import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {runMcpServer} from '../lib/v1/mcp.mjs';

for(const name of ['Claude Code','private@example.test'])test('MCP initialize emits only normalized client facts: '+name,async()=>{
  const input=new PassThrough(),output=new PassThrough(),rows=[];let text='';output.on('data',chunk=>text+=chunk);
  const running=runMcpServer({input,output,opsClient:{call:async()=>({})},telemetry:{observeFact:(event,properties)=>{rows.push({event,properties});throw Error('observer failed');}}});
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name,version:'1.2.3-private'}}})+'\n');
  await new Promise(resolve=>setTimeout(resolve,50));input.end();await running;
  assert.equal(JSON.parse(text.trim()).result.serverInfo.name,'faravan');assert.equal(rows.length,1);
  assert.deepEqual(rows[0],{event:'mcp_client_connected',properties:{client_family:name==='Claude Code'?'claude':'other',source:'reported'}});
});
test('invalid MCP initialize emits no client fact',async()=>{
  const input=new PassThrough(),output=new PassThrough(),rows=[];output.resume();
  const running=runMcpServer({input,output,opsClient:{},telemetry:{observeFact:(...row)=>rows.push(row)}});
  input.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'private'}}})+'\n');await running;assert.deepEqual(rows,[]);
});
