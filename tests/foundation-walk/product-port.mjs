import {opById} from '../../lib/v1/ops/registry.mjs';

// Local walk adapter, not a new wire protocol. Transport must be the normal
// operation boundary (including authorization, full schema validation and
// result verification). Never invoke registry handlers or REST directly here.
// Conservative assumption: only shapes registered at this revision may pass.
// In particular, legacy jobs.submit is NOT foundation runRequest support.
const fail = code => Object.assign(new Error(code), {code});
function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? fail('cancelled');
}
export function createWalkProductPort({transport, clock} = {}) {
  if (typeof transport !== 'function') throw fail('operation_transport_required');
  async function call(id, input = {}, options = {}) {
    const operation = opById(id);
    if (!operation) throw fail('unknown_operation');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_input');
    const schema = operation.input;
    // Fail closed on unregistered top-level fields instead of dropping selection
    // or replacing account/job/attempt identity. Full validation stays at transport.
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(schema?.properties ?? {}, key)) throw fail('unregistered_input');
    }
    for (const key of schema?.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) throw fail('missing_input');
    }
    aborted(options.signal);
    // Exactly one dispatch. Return/error by identity: operationKey and any
    // ambiguous-submit evidence stay intact and no automatic resubmit occurs.
    return transport(id, input, options);
  }
  async function wait(input, {maxPolls, pollMs, signal, ...options} = {}) {
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 1000 ||
        !Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 300000) throw fail('invalid_poll_budget');
    if (typeof clock?.sleep !== 'function') throw fail('test_clock_required');
    let response;
    for (let poll = 0; poll < maxPolls; poll++) {
      aborted(signal);
      response = await call('jobs.wait', {...input, timeout_seconds:0}, {...options, signal});
      if (typeof response?.done !== 'boolean' || !response.job || typeof response.job !== 'object') throw fail('invalid_wait_response');
      // "done" means only what jobs.wait says. Failure/cancellation is not a
      // successful result, and neither done nor idle is proof of cessation.
      if (response.done || poll + 1 === maxPolls) return response;
      await clock.sleep(pollMs, {signal});
    }
  }
  return Object.freeze({call, wait});
}
