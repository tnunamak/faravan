import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative,join} from 'node:path';
import {nonSbxCommand} from '../lib/sbx-runtime.mjs';
import {executableSites,unfencedSites,shellSbxSites} from './helpers/sbx-exec-census.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const exceptions=JSON.parse(readFileSync(new URL('./fixtures/non-sbx-process-sites.json',import.meta.url),'utf8'));
function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name)):[join(directory,entry.name)]);}
test('all sbx OS launches belong to docker-backend spawnSbxChild',()=>{
 const paths=[...files(join(root,'lib')),...files(join(root,'bin')),...files(join(root,'packaging/journey'))].filter(file=>/\.[cm]?js$/.test(file)||readFileSync(file,'utf8').startsWith('#!/usr/bin/env node'));
 const shells=files(join(root,'bin')).filter(file=>!paths.includes(file));
 assert.deepEqual(shells.flatMap(file=>shellSbxSites(readFileSync(file,'utf8'),relative(root,file))),[],'shell entrypoints cannot bypass the sbx boundary');
 const sites=paths.flatMap(file=>executableSites(readFileSync(file,'utf8'),relative(root,file)));
 assert.deepEqual(unfencedSites(sites,exceptions).map(({file,line,expression})=>({file,line,expression})),[],'a new process boundary needs an explicit non-sbx proof or the qualified choke point');
 assert.ok(sites.some(site=>site.qualified));
});
for(const [name,source] of Object.entries({
 dynamic:"const {spawn:launch}=await import('node:child_process');launch('sbx',[])",
 commonjs:"const {execFile:run}=require('child_process');run('sbx',[])",
 alias:"import {spawn as launch} from 'node:child_process';launch('sbx',[])",
 promisify:"import {execFile as raw} from 'node:child_process';import {promisify} from 'node:util';const execute=promisify(raw);execute(process.env.FARAVAN_SBX_BIN,[])",
 namespace:"import cp from 'node:child_process';const launch=cp.spawn;launch(bin,args)",
 injected:"import {execFile} from 'node:child_process';function probe({run=execFile}={}){run(binary,args)}",
 untagged:"runCommand('systemd-run',['--',owner.executable,'daemon','start'],options)",
 delegated:"import {execFile} from 'node:child_process';execFile('systemd-run',['--','sbx','daemon','start'])",
 shell:"import {spawn} from 'node:child_process';spawn('sh',['-c','exec sbx daemon start'])",
 helper:"process.execve('/usr/bin/env',['env','sbx','login'],process.env)",
 detector:"import {spawnSync} from 'node:child_process';spawnSync('sbx',['version'])",
}))test(`structural guard rejects a ${name} bypass`,()=>{assert.ok(unfencedSites(executableSites(source,'lib/new-helper.mjs'),exceptions).length>0);});

test('shell entrypoints cannot delegate an unfenced sbx launch',()=>{for(const source of ['exec sbx daemon start','/usr/local/bin/sbx version','systemd-run -- sbx daemon start','sh -c \"exec sbx version\"'])assert.equal(shellSbxSites(source,'bin/helper').length,1);});

test('reviewed host preflight boundary refuses the sandbox executable',()=>{
 assert.throws(()=>nonSbxCommand('sbx',{}),error=>error.sbxLaunchRefused===true);
 assert.throws(()=>nonSbxCommand('/configured/sandbox',{FARAVAN_SBX_BIN:'/configured/sandbox'}),error=>error.sbxLaunchRefused===true);
 assert.throws(()=>nonSbxCommand('/bin/ps',{FARAVAN_SBX_BIN:'/bin/ps'}),error=>error.sbxLaunchRefused===true);
 assert.equal(nonSbxCommand('/bin/ps',{FARAVAN_SBX_BIN:'/missing/sandbox'}),'/bin/ps');
});
