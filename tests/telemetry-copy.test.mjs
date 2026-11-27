import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {TELEMETRY_COPY} from '../lib/v1/telemetry/copy.mjs';
import {runTelemetryCommand} from '../lib/v1/telemetry/cli.mjs';
import {PRODUCT} from '../lib/v1/product.mjs';
test('the same short notice names PostHog and says recordings are opt-in without a duration promise',()=>{
 const notice=`${PRODUCT.name} sends usage data to PostHog for the ${PRODUCT.name} team. Screen recordings are sent only if you turn them on. Turn this off in Settings → Your data.`;
 assert.equal(TELEMETRY_COPY.firstRun.body,`${PRODUCT.name} sends usage data to help improve it.`);assert.equal(TELEMETRY_COPY.settings.intro,notice);assert.ok(TELEMETRY_COPY.cliNotice.startsWith(notice));
 assert.doesNotMatch(JSON.stringify(TELEMETRY_COPY),/\b\d+\s*(days?|months?|years?)\b|28-day|13 months/);
 assert.deepEqual(TELEMETRY_COPY.settings.choices.map(c=>c.level),['on','off']);
});
test('CLI prints the notice before choosing ON and rejects removed tier flags',async()=>{
 const output=[],calls=[];const io={client:{rest:async(method,path,options)=>{calls.push({method,path,options});return {effective:'on'};}},stdout:{write:text=>output.push(text)},stderr:{write:text=>output.push(text)}};
 assert.equal(await runTelemetryCommand(['on'],io),0);assert.ok(output[0].includes('PostHog'));assert.deepEqual(calls[0].options.body,{level:'on'});
 assert.equal(await runTelemetryCommand(['on','--level','counts'],io),2);assert.equal(calls.length,1);
});
test('privacy text explains the install pseudonym, reset limits and cross-account allowance',()=>{
 const text=TELEMETRY_COPY.privacyDetails.join(' ');assert.match(text,/random install ID/);assert.match(text,/outside this app/);assert.match(text,/cannot delete reports already sent/);assert.match(TELEMETRY_COPY.settings.turnOff,/cannot be recalled/);
});
