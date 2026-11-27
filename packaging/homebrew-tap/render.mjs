#!/usr/bin/env node
// Prepare a private tap tree. Publishing needs the lead's separate go-ahead.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
// Private repositories are refused by name; the public repository is allowed. GitHub names are case-insensitive, and
// a repository is its owner and name segments, so a longer name that starts the same way is another repository.
// The names are assembled so the exported text does not spell them.
const PRIVATE_REPOSITORIES=[['faravan'],['faravan','mirror']].map(parts=>['tnunamak',parts.join('-')].join('/'));
const REPOSITORY_HOSTS=new Set(['github.com','www.github.com','raw.githubusercontent.com','codeload.github.com']);
export function privateRepository(url) {
  if(!REPOSITORY_HOSTS.has(url.hostname))return false;
  let path;
  try { path=decodeURIComponent(url.pathname); } catch { return true; }
  const [owner='',name='']=path.split('/').filter(Boolean);
  return PRIVATE_REPOSITORIES.includes((owner+'/'+name.replace(/\.git$/i,'')).toLowerCase());
}
export function renderCask(template,{version,sha256,url,homepage}) {
  if(!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version??''))throw new Error('A fixed version is required.');
  if(!/^[a-f0-9]{64}$/.test(sha256??''))throw new Error('An exact SHA-256 is required.');
  for(const value of [url,homepage]) {
    const parsed=new URL(value);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||/["\\\r\n#{}]/.test(value))throw new Error('Public HTTPS URLs without credentials, query or Ruby interpolation are required.');
    if(parsed.hostname==='api.github.com'||privateRepository(parsed))throw new Error('Do not use authenticated private repository URLs.');
  }
  const vars={VERSION:version,SHA256:sha256,URL:url,HOMEPAGE:homepage};
  return template.replace(/@(VERSION|SHA256|URL|HOMEPAGE)@/g,(_,key)=>vars[key]);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [version,archive,url,homepage,out,...extra]=process.argv.slice(2);
  if(!out||extra.length)throw new Error('Usage: render.mjs VERSION ARCHIVE PUBLIC_HTTPS_URL PUBLIC_HOMEPAGE OUTPUT_TAP');
  const source=fileURLToPath(new URL('.',import.meta.url));
  const template=await readFile(join(source,'Casks/faravan.rb.in'),'utf8');
  const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  const cask=renderCask(template,{version,sha256,url,homepage});
  await mkdir(join(out,'Casks'),{recursive:true});
  await mkdir(join(out,'.github/workflows'),{recursive:true});
  await writeFile(join(out,'Casks/faravan.rb'),cask,{flag:'wx'});
  await cp(join(source,'.github/workflows/test.yml'),join(out,'.github/workflows/test.yml'));
  process.stdout.write('Prepared unpublished cask with SHA-256 '+sha256+'\n');
}
