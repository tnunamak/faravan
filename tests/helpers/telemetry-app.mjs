// A running app on the shared fixture (tests/helpers/v1-app-fixture.mjs) with telemetry switched on and a capture transport.
import { api, appFixture } from './v1-app-fixture.mjs';
import { RELEASE, captureTransport,catalogRemoteFactory,catalogView } from './telemetry-harness.mjs';

/** Real time plus a jump: the app keeps running on real time while a test moves telemetry's periods forward. */
function offsetClock() {
  let offset = 0;
  return {now: () => Date.now() + offset, advance: ms => { offset += ms; return Date.now() + offset; }};
}

/**
 * telemetryApp(t, {level, region, fixture, extra}) -> {f, app, tel, transport, clock, records(), step(ms)}.
 * The clock is manual and shared with the app; `records()` runs the housekeeping and returns every queued and sent record.
 */
export async function telemetryApp(t, {level = 'on', region = 'US', fixture = {}, extra = {}} = {}) {
  const f = await appFixture(t, fixture);
  const transport = captureTransport();
  const clock = offsetClock();
  const {app} = await f.start('owner', {version: RELEASE, env: {...process.env, FARAVAN_NO_TELEMETRY: '0', DO_NOT_TRACK: '0'}, telemetryTransport: transport, clock: {now: clock.now},
    telemetryOptions: {remoteFactory:catalogRemoteFactory,tripwire: async () => null, random: () => 0}, ...extra});
  if (level) app.telemetry.choose({level,region});
  const tel = app.telemetry;
  const records = async ({close = true} = {}) => {
    if (close) clock.advance(2 * 86400000);
    tel.tick();
    const {items} = tel.preview();
    return items.flatMap(item => (item.state === 'queued' ? [JSON.parse(item.body)] : JSON.parse(item.body).batch.map(catalogView)));
  };
  return {f, app, tel, transport, clock, records, step: ms => clock.advance(ms)};
}
