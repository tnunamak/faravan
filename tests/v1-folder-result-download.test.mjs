import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFilesArchive} from '../lib/v1/source-ingest.mjs';
import {prepareFolderResultDownload} from '../lib/v1/folder-result-download.mjs';
const source=()=>sourceFilesArchive([{path:'notes.txt',base64:Buffer.from('old\n').toString('base64')},{path:'keep.txt',base64:Buffer.from('keep\n').toString('base64')},{path:'delete.txt',base64:Buffer.from('gone\n').toString('base64')}]);
const patch=Buffer.from('diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/sub/plan.txt b/sub/plan.txt\nnew file mode 100644\n--- /dev/null\n+++ b/sub/plan.txt\n@@ -0,0 +1 @@\n+plan\ndiff --git a/delete.txt b/delete.txt\ndeleted file mode 100644\n--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
function entries(bytes){const found={};for(let i=0;bytes.readUInt32LE(i)===0x04034b50;){const length=bytes.readUInt32LE(i+18),n=bytes.readUInt16LE(i+26),extra=bytes.readUInt16LE(i+28),start=i+30+n+extra;found[bytes.subarray(i+30,i+30+n).toString()]=bytes.subarray(start,start+length).toString();i=start+length;}return found;}
test('plain folder download reconstructs only changed and added files from the sent snapshot',async()=>{
 const before=source(),out=await prepareFolderResultDownload({source:before,patch,jobId:'abc'});
 assert.equal(out.contentType,'application/zip');assert.equal(out.filename,'faravan-abc-changed-files.zip');
 assert.deepEqual(entries(out.bytes),{'notes.txt':'new\n','sub/':'','sub/plan.txt':'plan\n'});
 assert.deepEqual(before,source(),'the saved source artifact is unchanged');
});
test('unsafe patch paths and symbolic links cannot enter the ZIP',async()=>{
 for(const unsafe of [patch.toString().replaceAll('sub/plan.txt','../plan.txt'), 'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+notes.txt\n'])await assert.rejects(prepareFolderResultDownload({source:source(),patch:Buffer.from(unsafe)}));
});
test('a mismatched saved snapshot fails without returning partial files',async()=>{
 await assert.rejects(prepareFolderResultDownload({source:sourceFilesArchive([{path:'notes.txt',base64:Buffer.from('different\n').toString('base64')}]),patch}));
});

test('changed-files endpoint downloads the verified result from the saved folder after the original moves', {timeout:120000}, async t=>{
 const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
 const {mkdir,writeFile,rename,readFile}=await import('node:fs/promises');const {join}=await import('node:path');
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const folder=join(f.root,'plain-project');await mkdir(folder);
 for(const [path,text] of Object.entries({'notes.txt':'old\n','keep.txt':'keep\n','delete.txt':'gone\n'}))await writeFile(join(folder,path),text);
 const sent=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,repo:{path:folder},prompt:'Update notes and make a plan.',harness:'codex',send_anyway:true}});
 await f.complete(sent.jobDigest,'lender',{candidate:patch,candidateMediaType:'text/x-diff'});
 await rename(folder,folder+'-moved');
 const path='/api/jobs/'+encodeURIComponent(sent.jobDigest)+'/changed-files?circle='+circle.id;
 const response=await fetch(owner.app.origin+path,{headers:{'x-faravan-session-token':owner.app.token}});
 assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'application/zip');
 assert.match(response.headers.get('content-disposition'),/-changed-files.zip/);
 assert.deepEqual(entries(Buffer.from(await response.arrayBuffer())),{'notes.txt':'new\n','sub/':'','sub/plan.txt':'plan\n'});
 assert.equal(await readFile(join(folder+'-moved','notes.txt'),'utf8'),'old\n');
 const refused=await fetch(lender.app.origin+path,{headers:{'x-faravan-session-token':lender.app.token}});assert.equal(refused.status,409);
});

test('binary additions keep exact bytes and a deletion-only result produces an empty ZIP',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'faravan-binary-download-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root});
 git('init','-q','--template=');const binary=Buffer.from([0,1,2,0,255]);await writeFile(join(root,'blob.bin'),binary);git('add','blob.bin');
 const out=await prepareFolderResultDownload({source:source(),patch:git('diff','--cached','--binary')});
 const length=out.bytes.readUInt32LE(18),n=out.bytes.readUInt16LE(26),start=30+n;
 assert.deepEqual(out.bytes.subarray(start,start+length),binary);
 const deletion=Buffer.from('diff --git a/delete.txt b/delete.txt\ndeleted file mode 100644\n--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
 const empty=await prepareFolderResultDownload({source:source(),patch:deletion});assert.equal(empty.bytes.readUInt32LE(0),0x06054b50);assert.equal(empty.bytes.readUInt16LE(8),0);
});
test('changed destinations that collide on Windows or macOS are refused',async()=>{
 const one=name=>'diff --git a/'+name+' b/'+name+'\nnew file mode 100644\n--- /dev/null\n+++ b/'+name+'\n@@ -0,0 +1 @@\n+data\n';
 await assert.rejects(prepareFolderResultDownload({source:source(),patch:Buffer.from(one('a.txt')+one('A.txt'))}));
});
