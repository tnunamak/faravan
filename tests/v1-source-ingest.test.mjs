import './helpers/no-browser.mjs';
import test from 'node:test';
import {readArchiveEntries} from '../lib/archive.mjs';
import {storedZip} from './helpers/source-zip-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {folderFiles,zipFiles,sourceFilesArchive,resolveRepository,isSourceBase64} from '../lib/v1/source-ingest.mjs';

test('folder ingest excludes credential and noise paths before reads, refuses symlinks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-ingest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'main.txt'),'visible');await mkdir(join(root,'.ssh'));await writeFile(join(root,'.ssh','private'),'secret');
 const result=await folderFiles(root);assert.deepEqual(result.files.map(f=>f.path),['main.txt']);assert.equal(result.omitted[0].reason,'credentials');
 await symlink('/etc/hosts',join(root,'escape'));await assert.rejects(folderFiles(root),/symbolic links/);
});
test('folder ingest bounds bytes and count',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-ingest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'one'),'1234');await assert.rejects(folderFiles(root,{maxBytes:3}),/too large/);
 await writeFile(join(root,'two'),'x');await assert.rejects(folderFiles(root,{maxFiles:1}),/too many/);
});
test('ZIP parser refuses malformed and encrypted input',()=>{
 assert.throws(()=>zipFiles(Buffer.from('not zip')),/ZIP/);
});
test('repository resolution rejects credentials and non-HTTPS before executing git',async()=>{
 for(const url of ['file:///tmp/repo','https://user:secret@example.com/repo','-oProxyCommand=bad'])await assert.rejects(resolveRepository(url),/HTTPS/);
 const hash='a'.repeat(40);let args;
 const result=await resolveRepository('https://example.com/repo','main',{run:async(a)=>{args=a;return `${hash}\trefs/heads/main\n`;}});
 assert.equal(result.commit,hash);assert.equal(result.branch,'main');assert.ok(args.includes('credential.helper='));
});

test('ZIP permits source bytes and excludes secret names; refuses unsafe entries and expansion',()=>{
 assert.equal(Buffer.from(zipFiles(storedZip('src/main.js','hello')).files[0].base64,'base64').toString(),'hello');
 assert.equal(zipFiles(storedZip('.env','secret')).omitted[0].reason,'credentials');
 assert.throws(()=>zipFiles(storedZip('../escape','x')),/unsafe path/);
 assert.throws(()=>zipFiles(storedZip('/escape','x')),/unsafe path/);
 assert.throws(()=>zipFiles(storedZip('link','target',{mode:0xa000})),/symbolic links/);
 assert.throws(()=>zipFiles(storedZip('a','secret',{flags:1})),/Encrypted/);
 assert.throws(()=>zipFiles(storedZip('a','1234'),{maxBytes:3}),/too large/);
 const corrupt=storedZip('a','1234');corrupt[31]=0;assert.throws(()=>zipFiles(corrupt),/checksum/);
});

test('plain-folder and Unix ZIP source snapshots preserve executable bits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-mode-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'test.sh'),'#!/bin/sh\necho ok\n');await chmod(join(root,'test.sh'),0o755);
 const folder=await folderFiles(root);assert.equal(readArchiveEntries(sourceFilesArchive(folder.files),{preserveExecutable:true})[0].mode&0o111,0o111);
 const zip=zipFiles(storedZip('test.sh','echo ok',{mode:0o100755}));assert.equal(readArchiveEntries(sourceFilesArchive(zip.files),{preserveExecutable:true})[0].mode&0o111,0o111);
});

test('repository lookup failures give an actionable error without process output',async()=>{
 await assert.rejects(resolveRepository('https://example.test/repo',undefined,{run:async()=>{throw new Error('raw process output');}}),error=>error.code==='invalid_source' && /Check the public HTTPS URL/.test(error.message) && !error.message.includes('raw process'));
});

test('base64 validation handles full-sized uploads without a recursive regex',()=>{
 const large=Buffer.alloc(6*1024*1024,0x61).toString('base64');assert.equal(isSourceBase64(large),true);
 for(const bad of ['a','aa=a','a===','aaa=aaaa','abcd\n','@@@@'])assert.equal(isSourceBase64(bad),false,bad);
 for(const valid of ['', 'YQ==','YWE=','YWFh'])assert.equal(isSourceBase64(valid),true,valid);
});

test('plain-folder and ZIP monorepo snapshots apply the archive metadata byte gate',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-metadata-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path='packages/app/objects/aa/'+'b'.repeat(38);
 await mkdir(join(root,'packages/app/objects/aa'),{recursive:true});await writeFile(join(root,path),'dummy-object');
 const folder=await folderFiles(root);
 assert.throws(()=>sourceFilesArchive(folder.files),{code:'git_metadata_rejected'});
 const zip=zipFiles(storedZip(path,'dummy-object'));
 assert.throws(()=>sourceFilesArchive(zip.files),{code:'git_metadata_rejected'});
});

test('credential or Git metadata directories selected as source roots are refused before their entries are read',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-root-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const directory of ['.aws','.ssh','.kube','.git']){
  const nested=join(root,directory,'nested');await mkdir(nested,{recursive:true});
  await writeFile(join(nested,'random-name.json'),'DUMMY_ONLY=excluded');
  await assert.rejects(folderFiles(nested),directory==='.git'?/Git metadata/:/Credential folders/);
 }
});
