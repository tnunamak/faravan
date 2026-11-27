// Receipt metadata is immutable for an accepted result. Keep it across list/detail navigation.
const sessions = new WeakMap();
const keyOf = job => JSON.stringify([job.circle?.id, job.job_digest, job.result_digest ?? null]);
export function knownJobReceipt(api, job) {
  return sessions.get(api)?.get(keyOf(job))?.value;
}
export function loadJobReceipt(api, job) {
  let cache = sessions.get(api);
  if (!cache) { cache = new Map(); sessions.set(api, cache); }
  const key = keyOf(job);
  if (cache.has(key)) return cache.get(key).request;
  const entry = {};
  entry.request = api.get('jobs/' + encodeURIComponent(job.job_digest) + '/receipt?circle=' + encodeURIComponent(job.circle.id), AbortSignal.timeout(10000))
    .then(value => { entry.value = value; return value; })
    .catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
  cache.set(key, entry);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return entry.request;
}
