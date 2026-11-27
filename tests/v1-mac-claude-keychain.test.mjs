import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startProviderGenerationAuth,ownKeychainService} from '../lib/provider-generation-auth.mjs';
import {currentProviderGeneration} from '../lib/credential-generations.mjs';
import {CLAUDE_CODE_HARNESS} from '../lib/harnesses.mjs';
import {waitFor} from './helpers/v1-app-fixture.mjs';

// On a Mac the Claude CLI stores its login in the Keychain, not in its config folder. The CLI and `security` are fakes:
// the fake CLI stores the payload through the fake `security` under the service name the real CLI derives.
const ACCESS='sk-ant-oat01-'+'k'.repeat(64);
const testOptions={timeout:60000};
const expectedService=dir=>'Claude Code-credentials-'+createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0,8);

async function fixture(t,{securityFails=false}={}) {
  const home=await mkdtemp(join(tmpdir(),'mac-keychain-'));
  const old={home:process.env.FARAVAN_SBX_HOME,root:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{for(const [k,v] of [['FARAVAN_SBX_HOME',old.home],['FARAVAN_SCRATCH_ROOT',old.root]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const bin=join(home,'bin'),store=join(home,'keychain-store'),log=join(home,'security-calls'),envLog=join(home,'cli-env.json');
  await mkdir(bin);await mkdir(store);
  const security=join(bin,'security');
  await writeFile(security,`#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1" in
  store) printf '%s' "$3" > ${JSON.stringify(store)}/"$2" ;;
  find-generic-password) ${securityFails?'exit 44 ;;\n  x)':''} [ "$2" = -s ] && [ "$4" = -w ] && cat ${JSON.stringify(store)}/"$3" 2>/dev/null || exit 44 ;;
  delete-generic-password) rm ${JSON.stringify(store)}/"$3" ;;
  *) exit 2 ;;
esac
`,{mode:0o700});
  const provider=join(home,'claude');
  await writeFile(provider,'#!'+process.execPath+'\n'+`
    const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
    fs.writeFileSync(${JSON.stringify(envLog)},JSON.stringify({dir:process.env.CLAUDE_CONFIG_DIR,secure:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}));
    console.log('https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic');
    console.log('Paste code here if prompted >');
    process.stdin.on('data',()=>{
      const service='Claude Code-credentials-'+crypto.createHash('sha256').update(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR.normalize('NFC')).digest('hex').slice(0,8);
      const r=cp.spawnSync(${JSON.stringify(security)},['store',service,JSON.stringify({claudeAiOauth:{accessToken:${JSON.stringify(ACCESS)},refreshToken:'synthetic-refresh',expiresAt:9999999999999}})]);
      process.exit(r.status);
    });
  `,{mode:0o700});
  return {home,provider,security,store,log,envLog,env:{...process.env}};
}
async function signIn(f,platform) {
  const handle=await startProviderGenerationAuth(CLAUDE_CODE_HARNESS,{home:f.home,providerBin:f.provider,env:f.env,platform,securityBin:f.security});
  await waitFor(()=>handle.acceptsCode===true,'the CLI is waiting for a pasted code');
  handle.submitCode('ABCD-1234-efgh-5678');
  return handle;
}
const calls=f=>readFile(f.log,'utf8').then(s=>s.trim().split('\n'),()=>[]);

test('on a Mac, a Keychain-only Claude sign-in is read, published, and the Keychain entry deleted',testOptions,async t=>{
  const f=await fixture(t);
  const handle=await signIn(f,'darwin');
  const result=await handle.waitForCompletion();
  assert.equal(result.status,'complete');assert.equal(result.warning,undefined);
  const published=await currentProviderGeneration(f.home,'claude');
  assert.equal(JSON.parse(await readFile(join(published.directory,'.credentials.json'),'utf8')).claudeAiOauth.accessToken,ACCESS);
  const env=JSON.parse(await readFile(f.envLog,'utf8'));
  assert.equal(env.secure,env.dir,'the Keychain service is pinned to the config folder');
  const service=expectedService(env.dir);
  const seen=(await calls(f)).filter(l=>!l.startsWith('store '));
  assert.deepEqual(seen,['find-generic-password -s '+service+' -w','delete-generic-password -s '+service]);
  assert.deepEqual(await readdir(f.store),[],'the Keychain entry is gone');
});

test('on a Mac, a failed Keychain read fails the sign-in and publishes nothing',testOptions,async t=>{
  const f=await fixture(t,{securityFails:true});
  const handle=await signIn(f,'darwin');
  await assert.rejects(handle.waitForCompletion(),{code:'credential_writer_unresolved'});
  assert.equal(await currentProviderGeneration(f.home,'claude'),null);
});

test('on Linux the Keychain is never consulted',testOptions,async t=>{
  const f=await fixture(t);
  const handle=await signIn(f,'linux');
  await assert.rejects(handle.waitForCompletion(),{code:'credential_writer_unresolved'});
  assert.deepEqual((await calls(f)).filter(l=>!l.startsWith('store ')),[]);
});

test("the owner's default Keychain login is never read or deleted",testOptions,async t=>{
  const f=await fixture(t);
  const DEFAULT='Claude Code-credentials',OWNER='{"claudeAiOauth":{"accessToken":"owner-login"}}';
  await writeFile(join(f.store,DEFAULT),OWNER);
  const result=await (await signIn(f,'darwin')).waitForCompletion();
  assert.equal(result.status,'complete');
  assert.equal(await readFile(join(f.store,DEFAULT),'utf8'),OWNER,'the default item is unchanged');
  const env=JSON.parse(await readFile(f.envLog,'utf8'));
  assert.deepEqual(await readdir(f.store),[DEFAULT],'only the suffixed item was removed');
  const named=(await calls(f)).filter(l=>!l.startsWith('store '));
  assert.ok(named.length===2 && named.every(l=>l.includes(' -s '+expectedService(env.dir))));
  assert.ok(!named.some(l=>/-s Claude Code-credentials( |$)/.test(l)),'no command named the default service');
});

test('the guard refuses the default or an unsuffixed service name',()=>{
  for(const bad of ['Claude Code-credentials','Claude Code-credentials-','Claude Code-credentials-xyz','Claude Code-credentials-abcdef123','',undefined])
    assert.throws(()=>ownKeychainService(bad),{code:'credential_writer_unresolved'});
  assert.equal(ownKeychainService('Claude Code-credentials-0a1b2c3d'),'Claude Code-credentials-0a1b2c3d');
});
