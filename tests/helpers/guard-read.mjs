import {createGuardReads} from '../../lib/v1/guard-read.mjs';

// An issued guard-read context whose host read is the given function: `read({provider, accountKey, signal})`.
// Only a context issued this way confers the guard's bypass; a plain object never does.
export const guardReadFrom = (read, {provider = 'claude', accountKey = provider} = {}) =>
  createGuardReads({reader: {read: args => read(args)}})({provider, accountKey});
