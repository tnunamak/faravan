import {boundedFetch} from './v1-app-fixture.mjs';

// A join request reaches the host once. `receive` decides what the device sees of the host's first answer. A repeat with the
// same idempotency key gets that saved answer back, as the host replays an enrollment it already applied. `sent` records the
// key and body of every enrollment request so a test can compare a retry with the first attempt.
// `device` names a lender that runs on a fake clock. The coordinator judges a request from a named device by the instant it was
// signed; this transport replaces the app fixture's fetch, which adds that name, so it adds the name itself.
export function joinTransport(receive, sent, device) {
  const answers = new Map();
  const send = (url, options = {}) => boundedFetch(url, device ? {...options, headers: {...options.headers, 'x-test-device': device}} : options);
  return async (url, options = {}) => {
    if (!new URL(url).pathname.endsWith('/enrollments') || options.method !== 'POST') return send(url, options);
    const key = options.headers?.['Idempotency-Key'];
    const body = typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8');
    sent.push({key, body});
    if (!answers.has(key)) {
      const response = await send(url, options);
      answers.set(key, {status: response.status, text: await response.text()});
      return receive(answers.get(key));
    }
    return reply(answers.get(key));
  };
}

export function reply({status, text}) {
  return new Response(text, {status, headers: {'content-type': 'application/json'}});
}

export async function joinRequest(joiner, link) {
  return boundedFetch(joiner.app.origin + '/api/circles/join', {
    method: 'POST',
    headers: {'x-faravan-session-token': joiner.app.token, 'content-type': 'application/json'},
    body: JSON.stringify({link}),
  });
}

export function hostEnrollmentsFor(f, circleId, keyId) {
  return f.circles.get(circleId).enrollments.filter(item => item.device_key_id === keyId);
}
