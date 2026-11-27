// Why lending waits, named by its real cause. A signed-out or unchosen agent is not a sandbox problem, so its wait
// never says "Check protected workspace setup". The lender writes `label` from this; the web app reads the same rows.
// Every reason lender.mjs availability() can return is listed; an unknown reason keeps the generic sandbox wait.
export const AGENT_NAMES = Object.freeze({'claude-code-subscription':'Claude','claude-code-api-key':'Claude (API key)',codex:'ChatGPT (Codex)',
  gemini:'Gemini (API key)',opencode:'OpenCode','gh-cli':'GitHub CLI'});
export const agentDisplayName = id => AGENT_NAMES[id] ?? (typeof id === 'string' && /^[A-Za-z0-9 ._()-]{1,40}$/.test(id) ? id : '');
export const SANDBOX_WAIT = "Lending is on, but this computer can't run jobs right now. Check protected workspace setup.";
const GENERIC = Object.freeze({headline:'Waiting for setup', message:SANDBOX_WAIT, hint:'', remedy:'Open setup'});

/** {headline, message, hint, remedy} for a lending wait. `agent` is a display name; `setUp:false` marks an agent that
 * is neither installed nor signed in, which reads as quietly "Not lent" rather than as a problem. */
export function waitView(reason, {agent = '', setUp = true} = {}) {
  const name = agent || 'This agent';
  switch (reason) {
    case 'agent_signed_out':
      return {headline:'Sign-in needed', message:`${name} is signed out in Faravan.`, hint:'Sign it in on the Lend page.', remedy:'Sign in'};
    case 'agent_not_chosen':
      return setUp === false
        ? {headline:'Not lent', message:'Not lent.', hint:'', remedy:'Choose agents'}
        : {headline:'Not lent', message:`${name} isn't chosen for lending.`, hint:'Choose agents on the Lend page.', remedy:'Choose agents'};
    case 'no_ready_agent':
      return {headline:'Get an agent ready', message:'No agent is ready to lend on this computer.', hint:'Install or sign in to an agent on the Lend page.', remedy:'Set up an agent'};
    case 'lender_starting':
      return {headline:'Checking agent', message:`Checking whether ${agent || 'the agent'} is signed in…`, hint:'', remedy:'Refresh status'};
    case 'native_credentials_owner_only':
      return {headline:'Docker sign-in needed', message:'Native sign-in cannot run a borrowed job.', hint:'Sign in to Docker’s credential proxy on the Lend page to lend this subscription.', remedy:'Open Lending'};
    case 'host_disk_low':
      return {headline:'Low on disk space', message:'Cannot lend: this computer is low on disk space.', hint:'', remedy:'Open setup'};
    case 'host_disk_unreadable':
      return {headline:'Can’t read disk space', message:'Cannot lend: could not read free disk space.', hint:'', remedy:'Open setup'};
    default: // sandbox_not_ready and anything not listed
      return GENERIC;
  }
}
/** The one-line label a lender account carries while it waits. */
export const waitLabel = (reason, options) => {
  const view = waitView(reason, options);
  return view.hint ? view.message + ' ' + view.hint : view.message;
};
