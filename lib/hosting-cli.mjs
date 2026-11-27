/** CLI presentation of Gozar's current offers, consent and setup actions. */
import readline from 'node:readline/promises';
import {hostingError} from './coordinator-hosting.mjs';
import {readSecret} from './secret-prompt.mjs';
import {openUrl} from './v1/open-url.mjs';

export function routeSelector(value = 'public') {
  if (value === 'public' || value === 'private') return {reach:value === 'public' ? 'internet' : 'tailnet'};
  if (/^offer:[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) return {reach:'internet', providerId:value.slice(6)};
  throw hostingError('invalid_input', 'Choose public, private, or offer:<id> from Gozar.');
}

export function hostingInteraction({input = process.stdin, output = process.stderr} = {}) {
  const interactive = input.isTTY && output.isTTY;
  async function ask(prompt) {
    if (!interactive) throw hostingError('consent_required', 'Review and approve Gozar exposure in an interactive Faravan terminal.');
    const reader = readline.createInterface({input, output});
    try {return (await reader.question(prompt)).trim();}
    finally {reader.close();}
  }
  async function approve(snapshot) {
    output.write(JSON.stringify(snapshot, null, 2) + '\n');
    return /^y(?:es)?$/i.test(await ask('Approve this exact change? [y/N] '));
  }
  async function choose(offers) {
    if (!offers.length) throw hostingError('requirements_unsatisfied', 'Gozar found no offer meeting these requirements.');
    for (const [i, offer] of offers.entries()) {
      output.write('  ' + (i+1) + '. ' + offer.display.label + ' (' + offer.providerId + ', ' + offer.usage + ')\n');
      output.write('     ' + offer.display.needs + '\n');
    }
    const offer = offers[Number(await ask('Choose an offer: ')) - 1];
    if (!offer) throw hostingError('consent_required', 'No exposure offer selected.');
    return offer;
  }
  async function driveSetup(controller, operation, {cleanup = false} = {}) {
    while (operation && operation.nextAction) {
      const action = operation.nextAction;
      const ref = {operationId:operation.operationId, revision:operation.revision,
        consentFactsDigest:action.consent.consentFactsDigest};
      output.write(action.label + '\n');
      for (const text of [action.instructions,action.help,action.obtainUrl,action.href])
        if (text) output.write(text + '\n');
      if ((!cleanup && operation.state==='complete') || action.kind==='instructions' ||
          (!action.step.browser && action.kind==='open-url')) return operation;
      if (!await approve(action.consent)) return operation;
      const prior = operation;
      if (action.step.browser) {
        operation = await controller.browser(ref, openUrl);
        output.write('Finish the authorization in the browser, then run this command again.\n');
        return operation;
      }
      if (action.kind === 'provide-secret') {
        const bytes = Buffer.from(await readSecret({input,output,prompt:(action.secretLabel ?? action.label) + ': '}));
        try {
          const {handle} = await controller.intake({...ref,bytes});
          try {operation = await controller.acceptSetup(ref, {secretHandle:handle});}
          finally {await controller.discardInput(handle);}
        } finally {bytes.fill(0);}
      } else if (action.kind === 'provide-value') {
        const options = action.step.options;
        if (options) for (const [i, option] of options.entries()) output.write('  ' + (i+1) + '. ' + option.label + '\n');
        const value = await ask((action.valueLabel ?? action.label) + ': ');
        operation = await controller.acceptSetup(ref, {value:options ? options[Number(value)-1]?.value : value});
      } else {
        operation = await controller.acceptSetup(ref);
      }
      if (operation.revision === prior.revision || operation.nextAction?.consent.consentFactsDigest === ref.consentFactsDigest) return operation;
      if (!cleanup && operation.state === 'complete') return operation;
    }
    return operation;
  }
  return {interactive, ask, approve, choose, driveSetup};
}

export async function prepareHosting(controller, spec, interaction, {binding} = {}) {
  const current = controller.read();
  let offer;
  if (current) {
    // Select again to compare the requested scope with the saved operation.
    await controller.select({...spec, usage:current.spec.usage}, {providerId:spec.providerId ?? current.spec.providerId});
  } else {
    const offers = (await Promise.all(['durable','attached'].map(async usage =>
      (await controller.offers({...spec,usage})).map(offer => ({...offer,usage}))))).flat();
    offer = await interaction.choose(offers);
    await controller.select({...spec,usage:offer.usage}, offer);
  }
  const operation = await interaction.driveSetup(controller, await controller.setup());
  if (operation && operation.state !== 'complete')
    throw hostingError('setup_required', 'Gozar setup is still ' + operation.state + '.', {operation});
  const [ready] = await controller.offers(controller.read().spec);
  if (!ready?.approval) throw hostingError('setup_required', 'Gozar has not offered an approval for this exposure.');
  if (!await interaction.approve(ready.consent)) throw hostingError('consent_required', 'The exposure was not approved.');
  await controller.authorize(ready.consent.consentFactsDigest,{binding});
}
