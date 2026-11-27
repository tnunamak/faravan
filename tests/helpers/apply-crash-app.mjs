import './no-browser.mjs';
import { startApp } from '../../lib/v1/app.mjs';
import { syntheticBackend } from './v1-app-fixture.mjs';

// A normal app process with a loopback-only coordinator and no installed agents.
const app = await startApp({home: process.env.APPLY_TEST_HOME,origin: null,port: 0,backendFactory: async () => syntheticBackend(process.env.APPLY_TEST_ROOT),adapters: [],freshLending: 'off',autoApprove: false,identityProbe: async () => ({ providers: [] }),signInProbe: async () => ({ signedIn: null, source: 'unavailable' }),fetch: (url, options) => {
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('Non-loopback test request');
    return fetch(url, { ...options, headers: { ...options?.headers, 'x-test-device': 'owner' } });
  }});
process.send({ origin: app.origin, token: app.token });
process.on('message', async message => {
  if (message === 'close') { await app.close(); process.disconnect(); }
});
