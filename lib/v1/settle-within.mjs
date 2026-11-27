// Waits for a promise for at most `ms`. Resolves true when the work settled first, false when the bound passed first. A rejection
// counts as settled: a bounded wait reports whether the work finished, and the caller decides what that means.
export async function settleWithin(promise, ms) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
  const settled = Promise.resolve(promise).then(() => true, () => true);
  try {
    return await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}
