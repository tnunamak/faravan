// `faravan open-setup`: open the local app at the setup screen. The restart/log-out resume hook runs it
// (D8), and it is safe to run by hand. It starts the app if needed and signs the browser in with a one-time
// link, so no long-lived token goes into a URL the browser keeps.
import { openUrl as defaultOpenUrl } from './open-url.mjs';

export async function runOpenSetup(argv, {ensureHandoff, openUrl = defaultOpenUrl, stdout = process.stdout, stderr = process.stderr} = {}) {
  if (argv.length) { stderr.write('Usage: faravan open-setup\n'); return 2; }
  try {
    openUrl((await ensureHandoff()) + '#/setup');
    stdout.write('Opened Faravan where setup stopped.\n');
    return 0;
  } catch {
    stderr.write('faravan: could not open Faravan.\n');
    return 1;
  }
}
