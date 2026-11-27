import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workspaceFailure} from '../lib/docker-backend.mjs';
import {withCredentialPreparation} from '../lib/sandbox-credentials.mjs';
import {createSignin} from '../lib/v1/signin.mjs';
import {signInView} from '../ui/v1/src/signin.mjs';
import {agentCheckVM} from '../ui/v1/src/view-models.mjs';

test('an unresolved writer reports its own safe recovery guidance',async t=>{
  const home=await mkdtemp(join(tmpdir(),'review-r5-unresolved-'));
  const directory=join(home,'credential-writers');
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'11111111-1111-1111-1111-111111111111.json'),'{}',{mode:0o600});
  let failure;
  try { await withCredentialPreparation(home,async()=>{}); } catch(error) { failure=error; }
  assert.equal(failure?.code,'credential_writer_unresolved');
  const result=workspaceFailure(failure);
  assert.equal(result.cause,'credential_writer_unresolved');
  assert.match(result.fix,/contact|support/i);
  const signin=createSignin({adapters:async()=>[],backend:()=>({}),onComplete:async()=>{},startGitHub:async()=>{throw failure;}});
  t.after(()=>signin.close());
  await assert.rejects(signin.start('github'),{code:'credential_writer_unresolved'});
  assert.match(signInView(null,'credential_writer_unresolved').body,/previous sign-in/i);
  assert.equal(agentCheckVM({signInState:'Check failed',remedy:result.fix}).timeout,false);
});
