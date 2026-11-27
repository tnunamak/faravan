import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// /proc is also used by the journey to verify each installed app's identity.
export function processesUnder(run, proc = '/proc', sandboxBase = null) {
  const root = path.resolve(run);
  const inside = (dir, target) => target === dir || target.startsWith(dir + path.sep);
  return fs.readdirSync(proc).filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      const matches = ['cwd', 'exe'].some(link => {
        try {
          const target = fs.readlinkSync(path.join(proc, pid, link)).replace(/ \(deleted\)$/, '');
          return inside(root, target) || (sandboxBase && inside(sandboxBase, target));
        } catch (error) {
          if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return false;
          throw error;
        }
      });
      if (matches) return [Number(pid)];
      if (sandboxBase) {
        const env = fs.readFileSync(path.join(proc, pid, 'environ'), 'utf8');
        if (env.split('\0').some(entry => entry.startsWith('HOME=') && inside(sandboxBase, entry.slice(5)))) return [Number(pid)];
      }
      return [];
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return [];
      throw error;
    }
  });
}

function ownsSandboxBase(run, base) {
  if (!/^\/tmp\/fj-[a-zA-Z0-9]{6}$/.test(base)) return false;
  const marker = path.join(base, '.journey-run');
  return fs.lstatSync(base, {throwIfNoEntry:false})?.isDirectory() &&
    fs.lstatSync(marker, {throwIfNoEntry:false})?.isFile() &&
    fs.readFileSync(marker, 'utf8') === path.resolve(run) + '\n';
}

function preserveLogs(run, dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) preserveLogs(run, source);
    else if (entry.isFile() && entry.name.endsWith('.log')) {
      const destination = path.join(run, 'logs', path.relative(run, source));
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(source, destination);
    }
  }
}

export function finishJourney(run, status, stopResults = [], sandboxBase = process.env.JOURNEY_SBX_SHORT_HOME_BASE) {
  const ownedBase = sandboxBase && ownsSandboxBase(run, sandboxBase);
  const pids = processesUnder(run, '/proc', ownedBase ? sandboxBase : null);
  if (pids.length) console.error(`Journey cleanup left processes: ${pids.join(', ')}`);
  const file = path.join(run, 'summary.json');
  let summary;
  try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    console.error(`Journey cleanup could not read summary: ${error.message}`);
    return false;
  }
  const journeyPassed = summary.journeyChecksPassed === true;
  summary.pass = false;
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  const expectedStops = ['owner:host', 'owner:app', 'friend:host', 'friend:app'];
  const stopOutcomes = Object.fromEntries(expectedStops.map((scope, index) => {
    const result = stopResults.length === expectedStops.length ? stopResults[index] : undefined;
    const exitCode = /^(0|[1-9]\d{0,2})$/.test(result) && Number(result) <= 255 ? Number(result) : null;
    const state = result === 'not_needed' ? result : exitCode === 0 ? 'stopped' : 'unverified';
    return [scope, {state, exitCode}];
  }));
  const sandboxBaseKnown = !sandboxBase || ownedBase;
  const cleanupPassed = sandboxBaseKnown && pids.length === 0 && Object.values(stopOutcomes).every(outcome => outcome.state !== 'unverified');
  let pass = status === 0 && journeyPassed && cleanupPassed;
  summary.steps.push({name: 'cleanup', pass: cleanupPassed, survivingPids: pids, stopOutcomes});
  if (sandboxBase) {
    if (cleanupPassed) {
      try { fs.rmSync(sandboxBase, {recursive: true, force: true}); }
      catch (error) {
        console.error(`Journey cleanup could not remove its sandbox home: ${error.message}`);
        summary.steps.at(-1).pass = false;
        pass = false;
      }
    }
    if (!summary.steps.at(-1).pass) summary.steps.at(-1).retainedSandboxBase = sandboxBase;
  }
  if (summary.steps.at(-1).pass) {
    try {
      for (const dir of ['owner', 'friend', 'install-media', 'smoke']) preserveLogs(run, path.join(run, dir));
      if (pass) {
        for (const dir of ['owner', 'friend', 'install-media', 'smoke']) fs.rmSync(path.join(run, dir), {recursive: true, force: true});
      }
    } catch (error) {
      console.error(`Journey cleanup could not preserve evidence or remove disposable files: ${error.message}`);
      summary.steps.at(-1).pass = false;
      pass = false;
    }
  }
  summary.pass = pass;
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  return pass;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (finishJourney(process.argv[2], Number(process.argv[3]), process.argv.slice(4))) {
    const summary = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'summary.json'), 'utf8'));
    console.log(`PASS journey admission=${summary.smoke?.admissionMode ?? 'unknown'}`);
  } else process.exitCode = 1;
}
