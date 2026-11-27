// A one-time sign-in link for the running local app. The session token travels only in the request header: never in a
// URL, an opener argument or output. The app's code lasts 60 seconds and works once (loopback-security.mjs).

/** @returns {Promise<string>} the app's /auth/handoff?code=… link. Throws a bare Error with no URL or token in it. */
export async function requestHandoffLink({origin, token}, {fetch = globalThis.fetch, timeoutMs = 5000} = {}) {
  let response;
  try {
    response = await fetch(origin + '/api/handoff', {method: 'POST', body: '{}', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {'content-type': 'application/json', 'x-faravan-session-token': token}});
  } catch {
    throw new Error('the app did not give a sign-in link');
  }
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (typeof body?.url !== 'string' || !body.url.startsWith(origin + '/auth/handoff?code=')) throw new Error('the app did not give a sign-in link');
  return body.url;
}
