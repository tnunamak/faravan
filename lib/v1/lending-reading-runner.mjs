/**
 * The runner for every usage reading that is not the native guard's own. A reading is a host usage read of one account
 * (usage-host-reader.mjs): no sandbox, CLI or model is created, on any platform. It is never stop proof, so the result carries
 * no executor and no stop; stop evidence comes only from the stop check (stop-check.mjs).
 *
 * Sandbox transport does not exist here. A request that asks for one is refused, so no caller can bring it back by option.
 */
export function createLendingReadingRunner({reader} = {}) {
  if (typeof reader?.read !== 'function') throw new TypeError('A reading runner needs a host usage reader');
  return async function runLendingReading(request = {}) {
    const {provider, accountRef = null, signal} = request;
    if (request.transport === 'sandbox' || request.sandbox === true || request.backend != null)
      throw Object.assign(new TypeError('A usage reading never runs in a sandbox.'), {probe_failure: 'probe_unavailable'});
    if (typeof provider !== 'string') throw Object.assign(new TypeError('A usage reading needs a provider.'), {probe_failure: 'probe_unavailable'});
    return reader.read({provider, accountKey: request.accountKey ?? accountRef ?? provider, signal});
  };
}
