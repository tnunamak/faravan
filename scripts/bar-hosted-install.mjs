// Verification harness only: product startup always uses the downloaded package's runtime and CLI.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {readManifest, candidateURL, manifestCommit} from './bar-feed.mjs';

const run=promisify(execFile);
export function candidateAsset(manifest,sha,platform=process.platform,arch=process.arch) {
  assert.equal(manifestCommit(manifest),sha,'Candidate must be built from this workflow commit');
  const asset=platform==='linux'&&arch==='x64'
    ? manifest.deb&&{...manifest.deb,url:new URL(manifest.deb.file,manifest.tarball).href}
    : (manifest.assets??[]).find(a=>a.platform===platform&&a.kind==='macos-app-zip'&&[arch,'universal'].includes(a.arch));
  assert.ok(asset,'Candidate has no package for this runner');
  assert.equal(new URL(asset.url).protocol,'https:');
  assert.match(asset.sha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(asset.size)&&asset.size>0);
  return asset;
}
export function verifyDownload(bytes,asset) {
  assert.equal(bytes.length,asset.size,'Downloaded package size');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,'Downloaded package hash');
}
export async function until(check,label,timeout=60_000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    const value=await check();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Timed out: '+label);
}
export async function homeCheck(root,scratch,node=join(root,'runtime/bin/node')) {
  const home=join(scratch,'home-smoke');await mkdir(home,{recursive:true});
  const child=spawn(node,[join(root,'bin/faravan'),'app'],{stdio:'ignore',env:{...process.env,
    HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),
    FARAVAN_HOME:join(home,'app'),FARAVAN_COORDINATOR_HOME:join(home,'coordinator'),
    CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),
    FARAVAN_NO_BROWSER:'1',FARAVAN_NO_UPDATE:'1',FARAVAN_SBX_DAEMON_GATE:'off'}});
  let launchError;child.on('error',error=>{launchError=error;});
  try {
    const record=await until(async()=>{
      if(launchError)throw launchError;
      assert.equal(child.exitCode,null,'Installed app exited before Home');
      try{return JSON.parse(await readFile(join(home,'app/v1/app.json'),'utf8'));}
      catch(error){if(error.code==='ENOENT')return null;throw error;}
    },'installed app discovery');
    assert.equal(record.pid,child.pid);
    const origin='http://127.0.0.1:'+record.port;
    const page=await fetch(origin+'/',{signal:AbortSignal.timeout(30_000)});
    assert.equal(page.status,200,'Installed Home page');
    assert.match(await page.text(),/<html/i);
    const response=await fetch(origin+'/api/home',{headers:{'x-faravan-session-token':record.token},signal:AbortSignal.timeout(60_000)});
    assert.equal(response.status,200,'Home state read made by the page');
    const homeView=await response.json();
    assert.ok(homeView.intent&&homeView.lending&&Array.isArray(homeView.circles),'Home state shape');
    console.log('Installed app served its page and Home state.');
  } finally {
    if(child.exitCode===null&&child.signalCode===null&&child.pid) {
      const exited=once(child,'exit');child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
      try{await exited;}finally{clearTimeout(timer);}
    }
  }
}
export async function main([scratch,sha]) {
  assert.ok(scratch&&sha,'Usage: bar-hosted-install.mjs SCRATCH WORKFLOW_SHA');
  scratch=resolve(scratch);await mkdir(scratch,{recursive:true});
  const manifest=await readManifest(candidateURL);
  const asset=candidateAsset(manifest,sha);
  const response=await fetch(asset.url,{signal:AbortSignal.timeout(120_000)});
  assert.equal(response.status,200,'Package download');
  const bytes=Buffer.from(await response.arrayBuffer());verifyDownload(bytes,asset);
  const file=join(scratch,process.platform==='linux'?'candidate.deb':'candidate.zip');
  await writeFile(file,bytes);
  let root;
  if(process.platform==='linux') {
    await run('sudo',['apt-get','install','--yes',file],{timeout:120_000});
    root='/usr/lib/faravan';
  } else {
    const unpacked=join(scratch,'unpacked');await mkdir(unpacked);
    await run('ditto',['-x','-k',file,unpacked]);
    await run('ditto',[join(unpacked,'Faravan.app'),'/Applications/Faravan.app']);
    root='/Applications/Faravan.app/Contents/Resources/faravan';
  }
  const identity=JSON.parse(await readFile(join(root,'installed-source.json'),'utf8'));
  assert.equal(identity.sourceSha,sha);assert.equal(identity.version,manifest.version);
  await homeCheck(root,scratch);
  if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,'FARAVAN_BAR_INSTALL_ROOT='+root+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
