#!/usr/bin/env node
// Build from immutable source, check the shipped metadata, then sign exact bytes.
// --dry-run performs no GitHub mutations. The signing key is only passed by path.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm,readdir,copyFile,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyManifest,isNewer} from '../lib/v1/self-update.mjs';
import {UPDATE_PUBLIC_KEY} from '../lib/v1/update-key.mjs';
import {MAC_UPDATE_REQUIRED_FILES} from '../lib/v1/macos-update-helper.mjs';
import {verifyApp,parsePlist} from '../packaging/macos/bundle-tool.mjs';
import {validateMacAppZip} from '../lib/v1/macos-update-archive.mjs';

const run=promisify(execFile),repo='tnunamak/faravan-updates';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const datedVersion=/^\d+\.\d+\.\d+-preview\.\d{8}\.\d+$/;
const usage='release-candidate.mjs --commit SHA --version X.Y.Z-preview.YYYYMMDD.N [--dry-run] [--mac-zip FILE | --linux-only]\nrelease-candidate.mjs --promote VERSION [--dry-run]';
export function parseOptions(args) {
  const {values:v}=parseArgs({args,options:{commit:{type:'string'},version:{type:'string'},'dry-run':{type:'boolean'},'linux-only':{type:'boolean'},'mac-zip':{type:'string'},promote:{type:'string'}}});
  if(v.promote) {
    if(!datedVersion.test(v.promote)||Object.keys(v).some(key=>!['promote','dry-run'].includes(key)))throw Error(usage);
    return {promote:v.promote,dryRun:!!v['dry-run']};
  }
  if(!/^[0-9a-f]{7,40}$/i.test(v.commit??'')||!datedVersion.test(v.version??'')||v['linux-only']&&v['mac-zip'])throw Error(usage);
  return {commit:v.commit,version:v.version,dryRun:!!v['dry-run'],linuxOnly:!!v['linux-only'],macZip:v['mac-zip']?resolve(v['mac-zip']):null};
}
export function checkIdentity(versionText,metadata,{version,commit}) {
  if(versionText.trim()!==version||metadata?.schemaVersion!==1||metadata.version!==version||metadata.sourceSha!==commit)
    throw Error('Artifact version or source SHA does not match the requested version and commit');
}
export function verifyCandidate({bytes,signature,publicKey=UPDATE_PUBLIC_KEY,version,commit,artifacts}) {
  const manifest=verifyManifest(bytes,signature,publicKey);
  if(! /^[0-9a-f]{40}$/.test(manifest.sourceSha??'')||commit&&manifest.sourceSha!==commit)throw Error('Candidate sourceSha must identify the full 40-character source commit');
  if(manifest.version!==version)throw Error('Candidate version does not match the requested version');
  assertNewRelease(manifest,null);
  if(artifacts) {
    const signed=[{file:basename(new URL(manifest.tarball).pathname),sha256:manifest.sha256,size:manifest.size},
      ...(manifest.deb?[manifest.deb]:[]),...(manifest.assets??[]).filter(a=>a.platform==='darwin').map(a=>({...a,file:basename(new URL(a.url).pathname)}))];
    if(signed.length!==artifacts.length)throw Error('Candidate artifact count does not match');
    for(const expected of signed) {
      const actual=artifacts.find(a=>basename(a.file)===expected.file);
      if(!actual||actual.sha256!==expected.sha256||actual.size!==expected.size)throw Error('Candidate artifact hash or size does not match: '+expected.file);
    }
  }
  return manifest;
}
export function macArchitecture(bytes) {
  if(bytes.length<8)throw Error('Mac launcher is not a Mach-O executable');
  const cpuArch=cpu=>cpu===0x100000c?'arm64':cpu===0x1000007?'x64':null;
  if(bytes.readUInt32LE(0)===0xfeedfacf) {
    const arch=cpuArch(bytes.readUInt32LE(4));if(arch)return arch;
  }
  if(bytes.readUInt32BE(0)===0xcafebabe) {
    const count=bytes.readUInt32BE(4),arches=[];
    if(count<=8&&bytes.length>=8+20*count)for(let i=0;i<count;i++)arches.push(cpuArch(bytes.readUInt32BE(8+20*i)));
    if(arches.length===2&&arches.includes('arm64')&&arches.includes('x64'))return 'universal';
  }
  throw Error('Mac launcher has an unsupported architecture');
}
async function hashArtifact(file) {
  const hash=createHash('sha256');let size=0;
  for await(const chunk of createReadStream(file)){hash.update(chunk);size+=chunk.length;}
  return {file,sha256:hash.digest('hex'),size};
}
async function output(command,args,options={}) {
  return (await run(command,args,{maxBuffer:16*1024*1024,...options})).stdout;
}
async function logged(command,args,options={}) {
  await new Promise((accept,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',...options});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?accept():reject(Error(command+' failed ('+(signal??code)+')')));
  });
}
async function macArtifact(options,scratch) {
  let file=options.macZip;
  if(!file) {
    const runs=JSON.parse(await output('gh',['run','list','--workflow','release-macos.yml','--commit',options.commit,'--status','success','--json','databaseId,headSha','--limit','20'],{cwd:sourceRoot}));
    const match=runs.find(r=>r.headSha===options.commit);
    if(!match)throw Error('No successful macOS workflow run for '+options.commit+'. Supply --mac-zip FILE built from this commit/version, or explicitly choose --linux-only.');
    const dest=join(scratch,'mac');await mkdir(dest);
    await logged('gh',['run','download',String(match.databaseId),'--name','unsigned-universal-preview','--dir',dest],{cwd:sourceRoot});
    const zips=(await readdir(dest)).filter(n=>n.endsWith('.zip'));
    if(zips.length!==1)throw Error('macOS workflow artifact must contain exactly one app ZIP; supply --mac-zip FILE or --linux-only');
    file=join(dest,zips[0]);
  }
  const saved=join(scratch,basename(file));await copyFile(file,saved);file=saved;
  const bytes=await readFile(file);await validateMacAppZip(bytes);
  await output('unzip',['-t',file]);
  const unpacked=join(scratch,'unpacked');await mkdir(unpacked);
  await output('unzip',['-q',file,'-d',unpacked]);
  return {file,...await verifyMacApp(join(unpacked,'Faravan.app'),options)};
}
export async function verifyMacApp(app,options) {
  const res=join(app,'Contents/Resources/faravan');
  checkIdentity(await readFile(join(res,'VERSION'),'utf8'),JSON.parse(await readFile(join(res,'installed-source.json'),'utf8')),options);
  const channel=JSON.parse(await readFile(join(res,'channel.json'),'utf8'));
  const arch=macArchitecture(await readFile(join(app,'Contents/MacOS/faravan-launch')));
  await verifyApp(app,{arch:arch==='x64'?'x86_64':arch});
  const plist=parsePlist(await readFile(join(app,'Contents/Info.plist'),'utf8'));
  if(plist.CFBundleIdentifier!==channel.bundleId||plist.CFBundleVersion!==options.version||plist.CFBundleShortVersionString!==options.version)
    throw Error('Mac Info.plist does not match the embedded version and bundle ID');
  // The installed updater also requires the application and its update helper modules.
  for(const path of MAC_UPDATE_REQUIRED_FILES) {
    if(!(await lstat(join(app,path))).isFile())throw Error('Mac bundle required file is missing or is not a regular file: '+path);
  }
  try {await output('codesign',['--verify','--deep','--strict',app]);}
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    console.log('SKIPPED: codesign --verify --deep --strict (codesign is unavailable); bundle structure, versions and all native architectures checked.');
  }
  return {channel,arch};
}
export function assertNewRelease(next,current) {
  if(!Number.isFinite(Date.parse(next.released))||current&&(!isNewer(next.version,current.version)||
    !Number.isFinite(Date.parse(current.released))||Date.parse(next.released)<Date.parse(current.released)))
    throw Error('Release must be newer than the target feed version and must not have an earlier release date');
}
function signedAssets(manifest) {
  return [{file:basename(new URL(manifest.tarball).pathname),size:manifest.size,sha256:manifest.sha256},
    ...(manifest.deb?[manifest.deb]:[]),...(manifest.assets??[]).map(asset=>({...asset,file:basename(new URL(asset.url).pathname)}))];
}
export function checkReleaseAssets(manifest,release) {
  if(release.isDraft!==false)throw Error('Release must exist and be published');
  for(const expected of signedAssets(manifest)) {
    const asset=release.assets?.find(asset=>asset.name===expected.file);
    if(!asset||asset.size!==expected.size||asset.digest&&asset.digest!=='sha256:'+expected.sha256)
      throw Error('Release asset is missing or does not match signed size or digest: '+expected.file);
  }
}
async function checkUploadedRelease(manifest) {
  const release=JSON.parse(await output('gh',['release','view','v'+manifest.version,'--repo',repo,'--json','isDraft,assets']));
  checkReleaseAssets(manifest,release);
}
async function feedContents(branch,path,{optional=false}={}) {
  let value;
  try {value=JSON.parse(await output('gh',['api','repos/'+repo+'/contents/'+path+'?ref='+encodeURIComponent(branch)]));}
  catch(error) {if(optional&&/HTTP 404/.test(error.stderr??''))return null;throw error;}
  if(value.encoding!=='base64')throw Error('Feed file is missing: '+path);
  return Buffer.from(value.content,'base64');
}
async function checkTarget(branch,path,manifest,publicKey=UPDATE_PUBLIC_KEY) {
  const bytes=await feedContents(branch,path+'/update.json',{optional:true});
  if(bytes===null)return;
  const signature=await feedContents(branch,path+'/update.json.sig');
  assertNewRelease(manifest,verifyManifest(bytes,signature,publicKey));
}

async function pagesBranch() {
  const branch=(await output('gh',['api','repos/'+repo+'/pages','--jq','.source.branch'])).trim();
  if(!branch||branch==='null')throw Error('Feed repository must publish Pages from a branch');
  return branch;
}
async function ghJSON(scratch,name,endpoint,body) {
  const file=join(scratch,name+'.json');await writeFile(file,JSON.stringify(body));
  return JSON.parse(await output('gh',['api','--method','POST',endpoint,'--input',file]));
}
export async function publishPair(scratch,branch,path,bytes,signature) {
  // One commit publishes both files. A concurrent branch change refuses the ref update.
  const base='repos/'+repo+'/git/';
  const ref=JSON.parse(await output('gh',['api',base+'ref/heads/'+branch]));
  // Compare against this exact parent: a publication during the upload must not be overwritten.
  await checkTarget(ref.object.sha,path,JSON.parse(bytes));
  const parent=JSON.parse(await output('gh',['api',base+'commits/'+ref.object.sha]));
  const tree=[];
  for(const [name,data] of [['update.json',bytes],['update.json.sig',Buffer.from(signature)]]) {
    const blob=await ghJSON(scratch,name+'-blob',base+'blobs',{content:data.toString('base64'),encoding:'base64'});
    tree.push({path:path+'/'+name,mode:'100644',type:'blob',sha:blob.sha});
  }
  const nextTree=await ghJSON(scratch,'tree',base+'trees',{base_tree:parent.tree.sha,tree});
  const commit=await ghJSON(scratch,'commit',base+'commits',{message:'Publish '+path+' '+JSON.parse(bytes).version,tree:nextTree.sha,parents:[ref.object.sha]});
  const input=join(scratch,'ref.json');await writeFile(input,JSON.stringify({sha:commit.sha,force:false}));
  await output('gh',['api','--method','PATCH',base+'refs/heads/'+branch,'--input',input]);
}
export async function promote(version,scratch,{dryRun=false,publicKey=UPDATE_PUBLIC_KEY}={}) {
  const branch=await pagesBranch();
  const bytes=await feedContents(branch,'candidate/update.json'),signature=await feedContents(branch,'candidate/update.json.sig');
  const manifest=verifyCandidate({bytes,signature,version,publicKey});
  await checkTarget(branch,'preview',manifest,publicKey);
  await checkUploadedRelease(manifest);
  if(dryRun){console.log('DRY RUN: verified release assets; would copy signed candidate pair to preview/ and mark v'+version+' Latest.');return;}
  await publishPair(scratch,branch,'preview',bytes,signature);
  try {await logged('gh',['release','edit','v'+version,'--repo',repo,'--prerelease=false','--latest']);}
  catch(error) {
    console.error('Recovery: gh release edit v'+version+' --repo '+repo+' --prerelease=false --latest');
    throw error;
  }
}

export async function main(args=process.argv.slice(2)) {
  const options=parseOptions(args);
  const scratchRoot=join(process.env.TMPDIR||join(homedir(),'.tmp'),'faravan-release-candidate');await mkdir(scratchRoot,{recursive:true});
  const scratch=await mkdtemp(join(scratchRoot,'run-'));
  try {
    if(options.promote)return await promote(options.promote,scratch,{dryRun:options.dryRun});
    if(process.env.FARAVAN_NODE_BIN)throw Error('Release builds refuse the unpinned FARAVAN_NODE_BIN development runtime');
    if(process.platform!=='linux'||process.arch!=='x64')throw Error('Build Linux packages on a Linux x64 machine');
    options.commit=(await output('git',['rev-parse','--verify',options.commit+'^{commit}'],{cwd:sourceRoot})).trim();
    // Resolve the Mac input before spending time building Linux; Linux-only is explicit.
    const mac=options.linuxOnly?null:await macArtifact(options,scratch);
    const source=join(scratch,'source');await mkdir(source);
    const archive=join(scratch,'source.tar');
    await output('git',['archive','--format=tar','--output='+archive,options.commit],{cwd:sourceRoot});
    await output('tar',['-xf',archive,'-C',source]);await rm(archive);
    const env={...process.env,PACKAGE_VERSION:options.version,PACKAGE_SOURCE_SHA:options.commit,PACKAGE_DEB_TOOL:'dpkg-deb',TMPDIR:scratch};
    await logged('bash',['packaging/build.sh'],{cwd:source,env});
    // build.sh invokes linux-download.sh for preview versions.
    const dist=join(source,'packaging/dist'),tarball=join(dist,'faravan-linux-x64-'+options.version+'.tar.gz');
    const deb=join(dist,'faravan_'+options.version+'_amd64.deb');
    const readTar=path=>output('tar',['-xOf',tarball,'usr/lib/faravan/'+path]);
    checkIdentity(await readTar('VERSION'),JSON.parse(await readTar('installed-source.json')),options);
    const channel=JSON.parse(await readTar('channel.json'));
    const debTree=join(scratch,'deb');await output('dpkg-deb',['--extract',deb,debTree]);
    const debRoot=join(debTree,'usr/lib/faravan');
    checkIdentity(await readFile(join(debRoot,'VERSION'),'utf8'),JSON.parse(await readFile(join(debRoot,'installed-source.json'),'utf8')),options);
    const debVersion=(await output('dpkg-deb',['--field',deb,'Version'])).trim();
    const expectedDeb=(await output('bash',['-c','. packaging/deb-version.sh; deb_full_version "$PACKAGE_VERSION"'],{cwd:source,env})).trim();
    if(debVersion!==expectedDeb)throw Error('Debian control version does not match the requested version');
    if(mac&&(mac.channel.id!==channel.id||mac.channel.bundleId!==channel.bundleId))throw Error('Mac and Linux install identities disagree; build the Mac ZIP with the same channel and bundle ID');
    const tag='v'+options.version,url=file=>'https://github.com/'+repo+'/releases/download/'+tag+'/'+basename(file);
    const assetMap=[];
    if(mac)assetMap.push({file:mac.file,platform:'darwin',arch:mac.arch,kind:'macos-app-zip',channel:mac.channel.id,bundleId:mac.channel.bundleId,url:url(mac.file)});
    const map=join(scratch,'assets.json');if(mac)await writeFile(map,JSON.stringify(assetMap));
    const signed=join(scratch,'signed');
    await logged(process.execPath,[join(sourceRoot,'packaging/sign-update.mjs'),'--tarball',tarball,'--version',options.version,
      '--key',process.env.FARAVAN_UPDATE_KEY||join(homedir(),'.config/faravan-release/update-private.pem'),'--out',signed,
      '--source-sha',options.commit,'--tarball-url',url(tarball),'--linux-channel',channel.id,'--deb',deb,...(mac?['--asset-map',map]:[])]);
    const bytes=await readFile(join(signed,'update.json')),signature=await readFile(join(signed,'update.json.sig'));
    const files=[tarball,deb,...(mac?[mac.file]:[])],artifacts=await Promise.all(files.map(hashArtifact));
    const manifest=verifyCandidate({bytes,signature,version:options.version,commit:options.commit,artifacts});
    process.stdout.write(bytes);
    console.log('Verified exact manifest bytes and every artifact hash, version and source SHA.');
    if(options.dryRun) {
      console.log('DRY RUN: would create prerelease '+repo+' '+tag+' (Latest unchanged), upload '+files.map(file=>basename(file)).join(', ')+', update.json and update.json.sig; commit the signed pair to candidate/ on the Pages branch. preview/ stays untouched.');
      return;
    }
    const branch=await pagesBranch();
    await checkTarget(branch,'candidate',manifest);
    // A duplicate tag refuses instead of replacing published artifact bytes.
    await logged('gh',['release','create',tag,'--repo',repo,'--prerelease','--latest=false','--title',options.version,'--notes','Candidate build from '+options.commit,
      ...files,join(signed,'update.json'),join(signed,'update.json.sig')]);
    await checkUploadedRelease(manifest);
    try {await publishPair(scratch,branch,'candidate',bytes,signature);}
    catch(error) {
      console.error('Recovery: gh release delete '+tag+' --repo '+repo+' --yes; then rerun the candidate command.');
      throw error;
    }
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
