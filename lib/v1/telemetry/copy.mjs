// Shared app and CLI disclosure. The app must display this before collection starts.
import {PRODUCT} from '../product.mjs';
const notice=`${PRODUCT.name} sends usage data to PostHog for the ${PRODUCT.name} team. Screen recordings are sent only if you turn them on. Turn this off in Settings → Your data.`;
const off='Off stops collection and deletes reports waiting on this computer. Reports already sent cannot be recalled.';
export const TELEMETRY_COPY=Object.freeze({
 settings:Object.freeze({title:`Help improve ${PRODUCT.name}`,intro:notice,retention:'PostHog plan defaults apply.',turnOff:off,
  unavailable:'This build does not send reports.',
  choices:Object.freeze([{level:'on',label:'On',detail:'Include usage, model, plan, computer and allowance data.'},{level:'off',label:'Off',detail:'Send nothing.'}]),
  recordings:Object.freeze({label:'Also send screen recordings (text and inputs hidden)',detail:'Off unless you turn it on. Turning reports Off also stops recordings.'}),readers:`Reports go to the ${PRODUCT.name} team through PostHog.`,links:Object.freeze({preview:'See what we send',privacy:'Privacy details',resetId:'Get a new random ID'}),
  offBecause:variable=>`Off on this computer because ${variable} is set.`}),
 firstRun:Object.freeze({body:`${PRODUCT.name} sends usage data to help improve it.`,link:'Change in Settings',linkHref:'#/you/data',close:'Close',unavailable:'This build does not send reports.',unavailableWhere:'Settings → You → Your data',preview:'See what we send'}),
 cliNotice:notice+'\n'+off+`\nSee what is sent: ${PRODUCT.slug} telemetry show\nTurn it off: ${PRODUCT.slug} telemetry off\n`,
 cliEnvOff:variable=>`Telemetry is off for this command because ${variable} is set. To turn it off on this computer, run: ${PRODUCT.slug} telemetry off\n`,
 privacyDetails:Object.freeze(['Reports use one random install ID, never a name, email, account or hostname.','Allowance data includes use of the agent account outside this app.','A new random ID deletes queued reports. It cannot delete reports already sent.','PostHog receives network connections; location enrichment is disabled.','Screen recordings are off unless you turn them on. When on, they hide text and inputs.','PostHog plan defaults apply.',off]),
});
