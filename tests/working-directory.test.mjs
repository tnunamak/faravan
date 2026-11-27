import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkingDirectory,workingDirectoryCheck} from '../lib/working-directory.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('working directory is a bounded relative subdirectory, never shell or traversal syntax',()=>{
 assert.equal(validateWorkingDirectory('packages/my app'),'packages/my app');
 for(const value of ['', '.', '..','../a','a/../b','/tmp','C:/foo','a//b','a\\b','a\nb'])assert.throws(()=>validateWorkingDirectory(value));
});
test('guest working-directory check refuses missing directories and symlink ancestors',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workdir-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'packages','app'),{recursive:true});await symlink(join(root,'packages'),join(root,'link'));
 const check=path=>execFileSync('sh',['-c',workingDirectoryCheck('.',path)],{cwd:root,encoding:'utf8'});
 assert.match(check('packages/app'),/FARAVAN_WORKDIR_OK/);
 assert.throws(()=>check('missing'));assert.throws(()=>check('link/app'));
});
