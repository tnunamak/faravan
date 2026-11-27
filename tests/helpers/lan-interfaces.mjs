// Test harness only. Loaded with `--import` by twoFreshInstalls (v1-app-fixture.mjs), so it runs in the app and in
// the `faravan host` processes it starts, never in shipped code. Two computers on one test machine need one local-network
// address. Under `test-sandbox --net none` the only address is loopback, so the harness names it here.
//
// The address enters through os.networkInterfaces, the seam resolveLanUrl reads by default. The origin still goes through
// validateOrigin with lanMode, which keeps its private-address rule: only loopback and private addresses pass here.
import os from 'node:os';
import { isIPv4 } from 'node:net';

const address = process.env.FARAVAN_TEST_LAN_ADDRESS;
const privateOrLoopback = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
if (address !== undefined) {
  if (!isIPv4(address) || !privateOrLoopback.test(address))
    throw new Error('FARAVAN_TEST_LAN_ADDRESS must be a loopback or private IPv4 address, got ' + address);
  const real = os.networkInterfaces.bind(os);
  os.networkInterfaces = () => ({
    ...real(),
    'test-harness-lan': [{ address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00',
      internal: false, cidr: address + '/32' }],
  });
}
