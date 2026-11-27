/**
 * The native guard's own read context for one lent attempt's account. While a lent job holds the account, only a read made
 * through a context issued here may run (lending-probe.mjs createLendingReadings); every other caller gets account_busy.
 * The context is issued by this module and recognised by identity, so an object a caller builds cannot confer the bypass.
 *
 * A guard read is a host usage read of the attempt's own account and generation (usage-host-reader.mjs). It creates no sandbox,
 * and it is never stop proof: it carries no executor and no stop.
 */
const issued = new WeakSet();

export function createGuardReads({reader}) {
  return ({provider, accountKey}) => {
    if (typeof provider !== 'string' || typeof accountKey !== 'string') throw new TypeError('A guard read needs a provider and an account key');
    const context = Object.freeze({provider, accountKey, run: ({provider: asked, signal} = {}) => {
      if (asked !== provider) return Promise.reject(Object.assign(new TypeError('The guard read belongs to another provider'), {probe_failure: 'probe_unavailable'}));
      return reader.read({provider, accountKey, signal});
    }});
    issued.add(context);
    return context;
  };
}
export const isGuardRead = value => issued.has(value);
