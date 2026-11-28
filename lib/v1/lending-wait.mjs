// Why lending waits, named by its real cause. A signed-out or unchosen agent is not a sandbox problem, so its wait
// never says "Check protected workspace setup". The lender writes `label` from this; the web app reads the same rows.
// Every reason lender.mjs availability() can return is listed; an unknown reason keeps the generic sandbox wait.
export const AGENT_NAMES = Object.freeze({'claude-code-subscription':'Claude','claude-code-api-key':'Claude (API key)',codex:'ChatGPT (Codex)',
  gemini:'Gemini (API key)',opencode:'OpenCode','gh-cli':'GitHub CLI'});
export const agentDisplayName = id => AGENT_NAMES[id] ?? (typeof id === 'string' && /^[A-Za-z0-9 ._()-]{1,40}$/.test(id) ? id : '');
export const SANDBOX_WAIT = "Lending is on, but this computer can't run jobs right now. Check protected workspace setup.";
import {lendingReason,lendingReasonCode,lendingReasonText} from './lending-reasons.mjs';
/** One reason list supplies the wait sentence and the next action to each surface. */
export function waitView(reason,{until=null,nextAction=null,detail=null}={}){
 const code=lendingReasonCode(reason),row=lendingReason(code);
 const headline=({account_signed_out:'Sign-in needed',provider_limit_reached:'Limit reached',lending_off:'Not lent',
  no_accounts:'Add an account',sandbox_cannot_start:'Sandbox setup needed',cleanup_pending:'Finishing cleanup'})[code]??'Waiting';
 return {headline,message:lendingReasonText(code,{until,nextAction,detail}),hint:'',remedy:nextAction?.label??row.action};
}
/** The one-line label a lender account carries while it waits. */
export const waitLabel = (reason, options) => {
  const view = waitView(reason, options);
  return view.hint ? view.message + ' ' + view.hint : view.message;
};
