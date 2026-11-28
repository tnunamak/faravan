import './helpers/no-browser.mjs';
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

const BASE='42712735558a8a80c2a5082302976cc1960942e5';
const repo=fileURLToPath(new URL('../',import.meta.url));
let available=true,readerRoot,oldApp,oldPolicy;
try{execFileSync('git',['cat-file','-e',BASE+'^{commit}'],{cwd:repo,stdio:'ignore'});}catch{available=false;}

before(async()=>{
  if(!available)return;
  await mkdir(join(repo,'test-artifacts'),{recursive:true});
  readerRoot=await mkdtemp(join(repo,'test-artifacts','rollback-reader-'));
  const tree=join(readerRoot,'tree'),archive=join(readerRoot,'reader.tar');
  await mkdir(tree);
  execFileSync('git',['archive','--format=tar','--output='+archive,BASE,'lib','bin','public/v1','docs/protocol','docs/support','package.json'],{cwd:repo});
  execFileSync('tar',['-xf',archive,'-C',tree]);
  await symlink(join(repo,'node_modules'),join(tree,'node_modules'),'dir');
  oldApp=await import(pathToFileURL(join(tree,'lib/v1/app.mjs')).href);
  oldPolicy=await import(pathToFileURL(join(tree,'lib/v1/lending-policy.mjs')).href);
  assert.equal(oldApp.APP_DEFAULTS.idleOnly,true);
  assert.equal(oldPolicy.normalizeLendingPolicy().stopOnReturn,true);
});
after(async()=>{if(readerRoot)await rm(readerRoot,{recursive:true,force:true});});

const read=async file=>JSON.parse(await readFile(file,'utf8'));
const choices=settings=>[settings.limits.idleOnly,settings.limits.lendingPolicy.stopOnReturn,
  settings.limits.lendingPolicy.strategyParams.perJobPct];
async function installSettings(f,name,value){
  const file=join(await f.home(name),'v1','app-settings.json');
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value));
  return file;
}

for(const row of [
  {name:'stored defaults',version:0,idle:true,stop:true,cap:undefined,want:[true,true,10],
    edit:[false,false,25]},
  {name:'unversioned old presence defaults',idle:true,stop:true,cap:undefined,want:[true,true,10],
    edit:[false,false,0]},
  {name:'old presence defaults and explicit cap 25',version:12,idle:true,stop:true,cap:25,want:[true,true,25],},
  {name:'explicit opt-out and cap zero',version:12,idle:false,stop:false,cap:0,want:[false,false,0],},
  {name:'no-cap preview exception after an old owner write',version:12,idle:true,stop:true,cap:25,want:[true,true,25],
    edit:[false,false,undefined],clearCap:true},
  {name:'legacy policy with no cap',version:7,idle:false,stop:false,want:[false,false,10],
    policy:{preset:'fixed_share',fixedSharePct:37,keepPct:42,perJobPct:null,stopOnReturn:false},},
  {name:'legacy policy with cap zero',version:7,idle:true,stop:true,want:[true,true,0],
    policy:{preset:'fixed_share',fixedSharePct:37,keepPct:42,perJobPct:0,stopOnReturn:true},},
])test(`rollback reader keeps ${row.name} and re-upgrade keeps owner choices`,{
  timeout:120000,skip:available?false:'Pinned rollback build unavailable; run this check with full Git history before publishing.',
},async t=>{
  const head=await appFixture(t);
  const initial={version:1,name:'Rollback fixture',intent:'off',activeCircle:null,agents:{},modes:{},
    ...(row.version===undefined?{}:{configVersion:row.version}),limits:{...structuredClone(APP_DEFAULTS),idleOnly:row.idle,
      lendingPolicy:row.policy??{...normalizeLendingPolicy(),stopOnReturn:row.stop,strategyParams:row.cap===undefined?{}:{perJobPct:row.cap}}}};
  const headFile=await installSettings(head,'head',initial);
  const {app}=await head.start('head');
  await app.close();
  const written=await read(headFile);
  assert.deepEqual(choices(written),row.want);
  assert.equal(written.presenceDefaultsVersion,2);
  assert.equal(oldPolicy.repairLendingPolicy(written.limits.lendingPolicy,oldApp.APP_DEFAULTS.lendingPolicy),null,
    'the old policy reader accepts every saved policy key without repair');

  const rollback=await appFixture(t,{startApp:oldApp.startApp});
  const oldFile=await installSettings(rollback,'rollback',written);
  const {app:old}=await rollback.start('rollback');
  const view=await api(old,'/api/home');
  const oldLimits=structuredClone(view.lending.limits);
  assert.deepEqual(oldLimits.lendingPolicy.providerConsent,{},'the old reader supplies only its empty retired provider map');
  delete oldLimits.lendingPolicy.providerConsent;
  assert.deepEqual(oldLimits,written.limits,'the actual old startup preserves the current limits and owner choices');
  const loaded=await read(oldFile);
  assert.equal(loaded.presenceDefaultsVersion,2);
  if(row.edit)await api(old,'/api/lending/limits',{method:'POST',body:{idleOnly:row.edit[0],
    lendingPolicy:{stopOnReturn:row.edit[1],strategyParams:row.clearCap?{}:{perJobPct:row.edit[2]}}}});
  await old.close();
  const savedByOld=await read(oldFile);
  assert.equal(savedByOld.presenceDefaultsVersion,2);
  assert.deepEqual(choices(savedByOld),row.edit??row.want);

  const upgrade=await appFixture(t);
  const upgradeFile=await installSettings(upgrade,'upgrade',savedByOld);
  const {app:again}=await upgrade.start('upgrade');
  await again.close();
  const upgraded=await read(upgradeFile);
  const expected=structuredClone(savedByOld.limits);
  assert.deepEqual(expected.lendingPolicy.providerConsent,{});
  delete expected.lendingPolicy.providerConsent;
  if(row.clearCap)expected.lendingPolicy.strategyParams.perJobPct=10;
  assert.deepEqual(upgraded.limits,expected,'re-upgrade preserves explicit choices except the accepted no-cap preview rule');
  const {app:second}=await upgrade.start('upgrade');
  await second.close();
  const twice=await read(upgradeFile);
  assert.deepEqual(twice.limits,upgraded.limits);
});
