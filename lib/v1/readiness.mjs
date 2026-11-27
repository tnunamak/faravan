// `faravan --readiness`: the check the portable installer runs before it keeps a new runtime. A version print proves
// only that node can run the entry point. This starts the device code the app starts (a device key, the default circle,
// read back) in a throwaway home. It starts no server, makes no network call and reads no real data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runReadiness({stdout = process.stdout, stderr = process.stderr} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'faravan-readiness-'));
  try {
    const { openDevice } = await import('./device.mjs');
    const device = await openDevice({home, origin: null});
    if (!(await device.listCircles()).some(circle => circle.owned === true)) throw new Error('the default circle was not created');
    stdout.write('Faravan is ready.\n');
    return 0;
  } catch (error) {
    stderr.write('Faravan is not ready: ' + (error?.message ?? String(error)) + '\n');
    return 1;
  } finally {
    await rm(home, {recursive: true, force: true});
  }
}
