import {createInterface} from 'node:readline/promises';
import {supportPreview, saveSupportArchive} from './diagnostics.mjs';

const USAGE = 'Usage: faravan diagnostics export --output <path> [--yes]\n       faravan diagnostics export --preview\n';

export async function runDiagnosticsCommand([verb, ...args], {home, stdout = process.stdout, stderr = process.stderr,
  stdin = process.stdin, preview = () => supportPreview({home}), confirm} = {}) {
  let output, yes = false, previewOnly = false;
  if (args.includes('--help') || args.includes('-h') || verb === '--help') {stdout.write(USAGE); return 0;}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) output = args[++i];
    else if (args[i] === '--yes') yes = true;
    else if (args[i] === '--preview') previewOnly = true;
    else {stderr.write(USAGE); return 2;}
  }
  if (verb !== 'export' || (!output && !previewOnly) || (previewOnly && (output || yes))) {stderr.write(USAGE); return 2;}
  let snapshot;
  try {snapshot = await preview();}
  catch {stderr.write('The support preview could not be prepared. Try again.\n'); return 1;}
  stdout.write('Only support.json is included. Job aliases change with each export.\n' +
    'This archive is never uploaded. Usage telemetry follows your telemetry setting.\n\n' + snapshot.entries[0].body);
  if (previewOnly) return 0;
  if (!yes) {
    if (!confirm && !stdin.isTTY) {stderr.write('Not saved. Run in a terminal to review and save, or use --yes after review.\n'); return 6;}
    if (!confirm) confirm = async () => {
      const prompt = createInterface({input:stdin, output:stdout});
      try {return /^y(?:es)?$/i.test((await prompt.question('Save this archive locally? [y/N] ')).trim());}
      finally {prompt.close();}
    };
    if (!await confirm()) {stdout.write('Not saved.\n'); return 0;}
  }
  try {await saveSupportArchive(snapshot, output);}
  catch {stderr.write('The archive was not saved. Choose a new file in a writable folder.\n'); return 1;}
  stdout.write('Saved locally.\n');
  return 0;
}
