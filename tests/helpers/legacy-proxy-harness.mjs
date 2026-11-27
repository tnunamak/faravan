import {resolveHarness} from '../../lib/executor.mjs';

// Synthetic scheduling, recovery and accounting fixtures model the pre-native
// host proxy. Production native adapters are covered by owner-only refusal tests.
export function legacyProxyHarness(id) {
  const spec=resolveHarness(id);
  return spec.auth_strategy==='provider-file-generation'
    ? {...spec,auth_strategy:'docker-native-oauth',credential_in_guest:false} : spec;
}
