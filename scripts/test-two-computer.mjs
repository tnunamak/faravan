// Run: node scripts/test-two-computer.mjs --repeat-each=3
// Release gate: node scripts/test-two-computer.mjs --release (no other arguments). It runs all five journeys once and
// exits 1 unless each journey's own report proves a complete, first-attempt run (browser-verify-lib.mjs).
// The runner and Chromium get synthetic homes too; the app fixture gives each
// installation another independent set before it forks either process.
import {mkdtemp,mkdir,rm,readdir,readFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {releaseProblems} from './browser-verify-lib.mjs';

const release=process.argv.includes('--release');
const invariants=process.argv.includes('--invariants');
const args=process.argv.slice(2).filter(arg=>arg!=='--invariants'&&arg!=='--release');
if(release&&(invariants||args.length)){
  console.error('--release runs the five two-computer journeys and takes no other arguments; got: '+[...(invariants?['--invariants']:[]),...args].join(' '));
  process.exit(2);
}

const hostHome=homedir(),root=await mkdtemp(join(tmpdir(),'faravan-g2-runner-'));
const env={...process.env,FARAVAN_TEST_HOST_HOME:hostHome,FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:'',
  FARAVAN_TEST_RUNNER_ROOT:root,
  PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??join(hostHome,'.cache','ms-playwright')};
for(const [key,name] of Object.entries({HOME:'home',FARAVAN_HOME:'faravan',CODEX_HOME:'codex',CLAUDE_CONFIG_DIR:'claude',FARAVAN_COORDINATOR_HOME:'coordinator',TMPDIR:'tmp'})) {
  env[key]=join(root,name);await mkdir(env[key]);
}
await mkdir(join(root,'pending-cleanup'));
const files=['two-computer-loop.spec.mjs','two-computer-admission.spec.mjs','two-computer-summary-retry.spec.mjs','two-computer-pause-stop.spec.mjs','two-computer-offline.spec.mjs'];
const reportFile=file=>resolve('test-artifacts/browser-verify/rollout/'+file+'.json');
async function run(command,args,extraEnv={}) {
  const child=spawn(command,args,{env:{...env,...extraEnv},stdio:'inherit'});
  const [code,signal]=await once(child,'exit');
  if(code!==0)throw new Error(command+' failed: '+(signal??code));
}
try {
  await run('npm',['--prefix','ui','run','build','--silent']);
  // Separate invocations keep each journey's repeats consecutive and retain one report each.
  if(invariants)await run(process.execPath,[resolve('node_modules/@playwright/test/cli.js'),'test','-c','tests/browser-verify/invariants.config.mjs',...args]);
  else for(const file of files){
    // A report left by an earlier run must not stand in for this one.
    if(release)await rm(reportFile(file),{force:true});
    await run(process.execPath,[resolve('node_modules/@playwright/test/cli.js'),'test','-c','playwright.verify.config.mjs',file,...args],{
      PLAYWRIGHT_JSON_OUTPUT_FILE:reportFile(file),
    });
  }
  if(release)for(const file of files){
    let problems;
    try { problems=releaseProblems(JSON.parse(await readFile(reportFile(file),'utf8'))); }
    catch { problems=['no fresh report for '+file]; }
    if(problems.length){
      console.error('Release gate FAILED for '+file+':\n'+problems.map(p=>' - '+p).join('\n'));
      process.exitCode=1;
    }
  }
  if(release&&!process.exitCode)console.log('Release gate: all five journeys ran once, none skipped');
} catch(error){console.error(error.message);process.exitCode=1;}
finally {
  if((await readdir(join(root,'pending-cleanup'))).length){console.error('Retained ownership records: process cleanup was not proven: '+root);process.exitCode=1;}
  else await rm(root,{recursive:true,force:true});
}
