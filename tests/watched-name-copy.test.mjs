import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sandboxRemediationLines,sandboxRemovalCommands,watchedNameStatus,listingUnreadableCopy} from '../lib/sandbox-remediation.mjs';
import {cleanupStatusSummary} from '../lib/v1/cleanup-status.mjs';
import {cleanupStatusVM} from '../ui/v1/src/cleanup-status.mjs';

const NAME='wf-0123456789abcdef',HOME='/home/someone/.private-sbx-home';
const BANNED=/verdict|receipt|attempt|settled|lease/i;
const clean=text=>{
  assert.doesNotMatch(text,/—|–/,'no em or en dashes');
  assert.doesNotMatch(text,BANNED,'no banned words');
  assert.doesNotMatch(text,/watch_generation|create_incarnation|_cleanupId|sbx_home|seen_absent|present_without_receipt|creation_unproven|credential_revocation_pending|undefined|\[object/,'no internal field names');
  assert.doesNotMatch(text,/\/home\/|\.private-sbx-home|token|secret/i,'no private path or token');
};

test('a failed or thrown revocation says it retries on its own and nothing is left to do', () => {
  const status=watchedNameStatus({name:NAME,home:HOME,reason:'credential_revocation_pending'});
  assert.deepEqual(status,{nothing_to_do:true,
    text:`Sandbox ${NAME} is waiting for its saved access to be removed. Faravan tries again on its own. Nothing to do.`});
  clean(status.text);
});

test('a failed create with no sandbox says nothing was found to remove and nothing is left to do', () => {
  const status=watchedNameStatus({name:NAME,home:HOME,reason:'creation_unproven'});
  assert.equal(status.nothing_to_do,true);
  assert.equal(status.text,`Sandbox ${NAME} did not start and is not listed yet. Faravan did not remove it, because there is nothing to remove, and keeps watching in case it appears. Nothing to do.`);
  clean(status.text);
});

test('a listed sandbox never seen absent names the existing removal command, or says nothing to do without one', () => {
  const command=`docker sandbox rm ${NAME}`;
  const withCommand=watchedNameStatus({name:NAME,home:HOME,reason:'present_without_receipt',command});
  assert.equal(withCommand.nothing_to_do,false);
  assert.equal(withCommand.text,`Sandbox ${NAME} is listed, and Faravan did not remove it, because it did not see it absent first. If this install created the job, run this command to remove it:\n${command}`);
  clean(withCommand.text.replace(command,''));
  const without=watchedNameStatus({name:NAME,home:HOME,reason:'present_without_receipt'});
  assert.deepEqual(without,{nothing_to_do:true,
    text:`Sandbox ${NAME} is listed, and Faravan did not remove it, because it did not see it absent first. Nothing to do.`});
  clean(without.text);
});

test('the lines the app shows carry each sentence, and the folder never appears', () => {
  const lines=sandboxRemediationLines([
    {name:NAME,home:HOME,reason:'credential_revocation_pending',step:'github_secret'},
    {name:'wf-1111111111111111',home:HOME,reason:'creation_unproven'},
    {name:'wf-2222222222222222',home:HOME,reason:'present_without_receipt'},
  ]);
  assert.equal(lines.length,3);
  assert.match(lines[0],/Faravan tries again on its own\. Nothing to do\.$/);
  assert.match(lines[0],/access was removed|network/);
  assert.match(lines[1],/Faravan did not remove it, because there is nothing to remove/);
  assert.match(lines[2],/did not see it absent first\. Nothing to do\.$/);
  for(const line of lines.slice(1))clean(line);
  assert.doesNotMatch(lines.join('\n'),/\.private-sbx-home/);
});

test('watching while the sandbox list cannot be read says Docker must answer and nothing is left to do', () => {
  const copy=listingUnreadableCopy(3);
  assert.deepEqual(copy,{nothing_to_do:true,
    text:'Waiting for Docker to list sandboxes, so 3 watched sandbox names cannot be confirmed gone yet. Faravan checks again on its own. Nothing to do.'});
  assert.match(listingUnreadableCopy(1).text,/1 watched sandbox name cannot/);
  clean(copy.text);
  const summary=cleanupStatusSummary({shared_watch:{healthy:true,count:3,listing_failed:true}});
  assert.equal(summary.shared_watch.message,'watching 3 names until listing works');
  assert.equal(summary.shared_watch.detail,copy.text);
  assert.equal(summary.shared_watch.nothing_to_do,true);
  assert.equal(cleanupStatusSummary({shared_watch:{healthy:true,count:3,listing_failed:false}}).shared_watch.detail,undefined);
  // The browser model repeats the sentence; both must say the same thing.
  const watch=cleanupStatusVM({shared_watch:{healthy:true,count:3,listing_failed:true}}).watch;
  assert.equal(watch.detail,copy.text);
  assert.equal(watch.nothing_to_do,true);
  assert.equal(cleanupStatusVM({shared_watch:{healthy:true,count:1,listing_failed:true}}).watch.detail,listingUnreadableCopy(1).text);
});

// A removal command made by the backend names the sandbox home, the state folder and the program path. Those never go
// into the sentence the owner reads in the lender label; the command is its own field.
test('the sentence for a listed sandbox never copies paths or environment fields from its removal command', () => {
  const command=`env -u XDG_STATE_HOME HOME='/private/alice/sandbox' '/opt/docker/sandbox' rm --force '${NAME}'`;
  const status=watchedNameStatus({name:NAME,home:HOME,reason:'present_without_receipt',command});
  assert.equal(status.nothing_to_do,false,'a command exists, so there is something the owner can do');
  assert.doesNotMatch(status.text,/\/private\/alice|\/opt\/docker|XDG_STATE_HOME|HOME=/);
  assert.match(status.text,/did not see it absent first/);
  assert.equal(status.command,command,'the command is carried separately for a place that may show it');
  clean(status.text);
  const lines=sandboxRemediationLines([{name:NAME,home:HOME,reason:'present_without_receipt',command}]);
  assert.equal(lines.length,1);
  assert.doesNotMatch(lines.join('\n'),/\/private\/alice|\/opt\/docker|XDG_STATE_HOME|HOME=|rm --force/);
  clean(lines[0]);
  assert.deepEqual(sandboxRemovalCommands([{name:NAME,home:HOME,reason:'present_without_receipt',command},{name:NAME,reason:'creation_unproven',command:'x'}]),[command]);
});

// Any shell assignment is an environment field, not only HOME= and XDG_: the sentence never carries it.
for(const command of [`DOCKER_CONTEXT=private-prod docker sandbox rm ${NAME}`,`docker sandbox rm ${NAME}`.replace('docker','DOCKER_HOST=tcp://private:2375 docker'),
  `FOO=bar BAZ=qux docker sandbox rm ${NAME}`])
  test('the sentence for a listed sandbox never copies a shell assignment from its removal command: '+command.split(' ')[0],() => {
    const status=watchedNameStatus({name:NAME,home:HOME,reason:'present_without_receipt',command});
    assert.doesNotMatch(status.text,/DOCKER_|FOO=|BAZ=|private/);
    assert.equal(status.command,command,'the command is carried separately');
    assert.equal(status.nothing_to_do,false);
    const lines=sandboxRemediationLines([{name:NAME,home:HOME,reason:'present_without_receipt',command}]);
    assert.doesNotMatch(lines.join('\n'),/DOCKER_|FOO=|BAZ=|private/);
    assert.deepEqual(sandboxRemovalCommands([{name:NAME,home:HOME,reason:'present_without_receipt',command}]),[command]);
  });
