/** Local owner CLI for publishing the dedicated Faravan MCP listener. */
import {join} from 'node:path';
import {FaravanHostError} from '../host.mjs';
import {chatgptHosting} from '../coordinator-hosting.mjs';
import {hostingInteraction, prepareHosting, routeSelector} from '../hosting-cli.mjs';
import {configHome} from '../local-state.mjs';
import {createOpsClient} from './ops/execute.mjs';

const fail = message => {throw new FaravanHostError(message);};

export function chatgptSteps({url, local_url}) {
  return [
    'ChatGPT can reach Faravan at this address:',
    '  MCP URL: ' + url,
    '',
    '1. Open https://chatgpt.com/plugins > + > Add custom MCP server (older UI: Settings > Apps > Advanced > Developer mode).',
    '2. Name it Faravan, paste the MCP URL, and choose OAuth. Leave client ID and secret blank; registration is automatic.',
    '3. Open Faravan from its tray icon on this computer. Return to the local connection screen below, refresh it, and review the pending request.',
    '   Compare the XXXX-XXXX code on ChatGPT\'s authorize page with the one shown here, check the callback is chatgpt.com, then choose Allow read-only or Allow read and request actions. Connect within 10 minutes of running this command.',
    '4. Create/install the plugin. In a new chat type @ and select Faravan. Ask: What blocks lending?',
    '   Local connection screen: ' + local_url,
    '   This address is saved and reused after restarting Faravan. Keep this computer awake while using ChatGPT.',
    '   Every action waits for Allow in the local Faravan app. Ask ChatGPT to wait with approvals_wait afterwards.',
    '',
    'Stop sharing any time with: faravan connect chatgpt --stop',
  ];
}

/** Ask the running app for the exact gateway destination, then review it in this terminal. */
export async function connectChatgpt({home=configHome(), tunnel, roots, stop=false}={}, seams={}) {
  const client=seams.client??createOpsClient({home,...(seams.autostart===undefined?{}:{autostart:seams.autostart}),...(seams.fetch?{fetch:seams.fetch}:{})});
  const interaction=seams.interaction??hostingInteraction();
  const controller=()=>chatgptHosting(join(home,'v1'),seams.gozar);
  if(stop) {
    const result=await client.rest('POST','/api/chatgpt/disconnect',{body:{}});
    if(result.legacyCleanup || result.cleanup?.state==='unconfirmed')fail('ChatGPT access is closed locally. Provider cleanup is unconfirmed.');
    const operation=result.operation&&interaction.interactive
      ? await interaction.driveSetup(controller(),result.operation,{cleanup:true}):result.operation;
    if(operation?.nextAction||operation?.resources.some(resource=>!['retained','confirmed'].includes(resource.removal)))
      fail('ChatGPT access is closed locally. Gozar requires another setup cleanup step.');
    if(operation && result.operation?.nextAction)
      await client.rest('POST','/api/chatgpt/disconnect',{body:{}});
    return {connected:false};
  }
  const selection=tunnel===undefined?{reach:'internet'}:routeSelector(tunnel);
  if(selection.reach!=='internet')fail('ChatGPT needs a public HTTPS route.');
  const body={...(tunnel!==undefined&&{tunnel}),...(roots!==undefined&&{roots})};
  let result=await client.rest('POST','/api/chatgpt/start',{body});
  if(result?.status==='approval_required') {
    await prepareHosting(controller(),result.spec,interaction,{binding:result.approvalBinding});
    result=await client.rest('POST','/api/chatgpt/start',{body:{...body,approveExposure:true}});
  }
  if(!result?.url||!result.local_url)fail('The Faravan app has no verified ChatGPT address.');
  return result;
}

/** CLI entry: faravan connect chatgpt [--tunnel public|offer:<id>] [--root DIR]... [--stop] [--json]. */
export async function runConnectCommand(argv, {out = process.stdout, ...seams} = {}) {
  const [target, ...args] = argv;
  if (target !== 'chatgpt') fail('usage: faravan connect chatgpt [--stop] [--tunnel public|offer:<id>] [--root FOLDER]... [--json]');
  const options = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = () => args[++i] ?? fail(arg + ' requires a value');
    if (arg === '--json') json = true;
    else if (arg === '--stop') options.stop = true;
    else if (arg === '--tunnel') options.tunnel = value();
    else if (arg === '--root') (options.roots??=[]).push(value());
    else fail('unknown option ' + arg + '. Run faravan connect chatgpt --help.');
  }
  if (options.stop && args.some(arg => arg !== '--stop' && arg !== '--json')) fail('--stop cannot be combined with other options');
  let result;
  try {result = await connectChatgpt(options,seams);}
  catch(error) {
    const guidance=error.action?.instructions??error.nextAction?.instructions;
    if(guidance) throw new FaravanHostError(error.message+' '+guidance);
    throw error;
  }
  if (json) out.write(JSON.stringify({...result, schema_version:1, type:options.stop ? 'chatgpt_disconnected' : 'chatgpt_connected'}) + '\n');
  else for (const line of options.stop ? ['ChatGPT access stopped.'] : chatgptSteps(result)) out.write(line + '\n');
  if (json || options.stop || !out.isTTY) return 0;
  return watchPairing(result, {out, ...seams});
}

const WATCH_MS = 600000, POLL_MS = 2000, MAX_POLL_FAILURES = 3;
const sleepFor = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, {once:true});
});

/** Interactive only: print each new pending request's matching code until pairing closes, 10 minutes pass, or Ctrl-C. */
async function watchPairing(result, {out, client, home = configHome(), now = Date.now, sleep = sleepFor, signal, ...seams}) {
  client ??= createOpsClient({home, ...(seams.autostart === undefined ? {} : {autostart:seams.autostart}), ...(seams.fetch ? {fetch:seams.fetch} : {})});
  const interrupt = () => controller.abort();
  let controller;
  if (!signal) { controller = new AbortController(); signal = controller.signal; process.once('SIGINT', interrupt); }
  const seen = new Set(), deadline = now() + WATCH_MS;
  let failures = 0;
  out.write('\nWaiting for ChatGPT to ask for access (Ctrl-C to stop; pairing allows one decision).\n');
  try {
    while (!signal.aborted) {
      let status;
      try { status = await client.rest('GET', '/api/chatgpt/status', {signal}); failures = 0; }
      catch (error) {
        if (signal.aborted) break;
        if (++failures >= MAX_POLL_FAILURES) {
          out.write('Could not check pairing status (' + (error.message || error) + '). Use the local connection screen instead: ' + result.local_url + '\n');
          return 1;
        }
      }
      if (status) {
        for (const request of status.pending_requests ?? []) {
          if (seen.has(request.matching_code)) continue;
          seen.add(request.matching_code);
          out.write('\nNew request ' + request.matching_code + ' from ' + request.redirect_host + (request.is_chatgpt ? '' : ' (NOT chatgpt.com)') + '.\n' +
            '  Compare this code with the code on your own ChatGPT authorize tab. Allow it in the local Faravan app only if they match; otherwise deny.\n');
        }
        if (!status.pairing_until) { out.write('\nPairing is closed. If you allowed a request, ChatGPT is now connected. Run this command again to pair another time.\n'); return 0; }
      }
      if (now() >= deadline) { out.write('\nStopped waiting after 10 minutes. Pairing closes on its own; run this command again to reopen it.\n'); return 0; }
      await sleep(POLL_MS, signal);
    }
    out.write('\nStopped watching. Pairing stays open until it expires or you decide in the local Faravan app: ' + result.local_url + '\n');
    return 0;
  } finally { if (controller) process.off('SIGINT', interrupt); }
}
