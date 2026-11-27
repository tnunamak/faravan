// The `faravan telemetry` verbs that are not generated operations (`on` widens, so only a person at a terminal
// does it; `show` prints the exact bytes), and the notice interactive commands may print (design §4.6).
import { PRODUCT } from '../product.mjs';
import { discoverApp } from '../ops/execute.mjs';
import { TELEMETRY_COPY } from './copy.mjs';
import { envSwitch } from './switch.mjs';

const usage = `Usage: ${PRODUCT.slug} telemetry status|on|off|show|reset-id [--json]\n`;

const LEVEL_WORDS = {on:'on',off:'off'};
function describeState(view) {
  const reason = view.reason ?? {};
  if (reason.kind === 'env') return TELEMETRY_COPY.settings.offBecause(reason.env);
  const because = {policy_unreadable: ' (the settings file could not be read)', no_upload: ' (this build does not send reports)',
    notice_pending: ' (waiting for the notice to be shown)'}[reason.kind] ?? '';
  return `Telemetry is ${LEVEL_WORDS[view.effective] ?? view.effective}${because}.`;
}

/** Parse the output flag; unknown options are an error. */
function flagsOf(args) {
  const flags = {json: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else return {error: `Unknown option ${arg}.`};
  }
  return flags;
}

/** `telemetry on` and `telemetry show`. Returns the exit code. */
export async function runTelemetryCommand([verb, ...args], {client, stdout, stderr}) {
  const flags = flagsOf(args);
  if (flags.error || !['on', 'show'].includes(verb)) { stderr.write((flags.error ? `${PRODUCT.slug}: ${flags.error}\n` : '') + usage); return 2; }
  if (verb === 'on') {
    const level = 'on';
    stderr.write(TELEMETRY_COPY.cliNotice);
    const view = await client.rest('POST', '/api/telemetry/choose', {body: {level}});
    stdout.write(flags.json ? JSON.stringify(view) + '\n' : describeState(view) + '\n');
    return 0;
  }
  const preview = await client.rest('GET', '/api/telemetry/preview');
  if (flags.json) { stdout.write(JSON.stringify(preview) + '\n'); return 0; }
  const {state, items} = preview;
  stdout.write(describeState(state) + '\n');
  stdout.write(`Waiting to be sent: ${state.queued.counts} counts, ${state.queued.diagnostics} diagnostics, ${state.queued.quota} weekly summaries.\n`);
  for (const item of items) stdout.write(`\n--- ${item.state} · ${item.stream} · ${item.at} · ${item.bytes} bytes${item.status ? ' · ' + item.status : ''}\n${item.body}\n`);
  return 0;
}

/**
 * After a command that talked to the running app: on a terminal, print the pending notice without changing consent.
 * With an environment switch set, say how to turn telemetry off for good instead. Never starts the app.
 */
export async function announceTelemetry({client, home, env, stderr}) {
  try {
    if (!stderr.isTTY) return;
    if (!(await discoverApp(home))) return;
    const view = await client.rest('GET', '/api/telemetry');
    if (!view?.notice?.pending) return;
    const variable = envSwitch(env);
    if (variable) { stderr.write(TELEMETRY_COPY.cliEnvOff(variable)); return; }
    stderr.write(TELEMETRY_COPY.cliNotice);
    if (view.uploadable === false) stderr.write(TELEMETRY_COPY.settings.unavailable + '\n');
  } catch { /* a notice that cannot be shown is shown at the next command */ }
}
