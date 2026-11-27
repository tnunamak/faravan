// Test-only paint probe for the rendered invariants, enabled by INVARIANT_TEXT_CAPTURE=<dir>.
// The probe key holds the inputs of I08 ("Capped lenders cannot accept") in one string. A sample's key and a
// once-per-frame key are both read from the page, so a sample whose key appears in neither animation frame next to
// it was never painted. Nothing here runs unless capture is on.
export const probeKeyOf = () => {
  const text = document.body?.innerText ?? '';
  const run = [...document.querySelectorAll('button')].some((button) => /^Run it$/.test(button.textContent.trim()) &&
    !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length > 0);
  return [
    /Done for today|daily (?:job |minute )?limit (?:reached|used)/i.test(text) ? 'done' : '-',
    run ? 'run' : '-',
    /Ready for requests/i.test(text) ? 'ready' : '-',
    location.hash,
  ].join(' ');
};

// Installed with page.addInitScript before any navigation. Records [epochMs, keyIndex] for every animation frame.
export const FRAME_PROBE = `(() => {
  if (window.__invariantFrames) return;
  const probeKeyOf = ${probeKeyOf.toString()};
  const keys = [], indexes = new Map(), frames = [];
  window.__invariantFrames = {keys, frames};
  window.__invariantProbeKey = probeKeyOf;
  const onFrame = (time) => {
    const key = probeKeyOf();
    if (!indexes.has(key)) { indexes.set(key, keys.length); keys.push(key); }
    frames.push([performance.timeOrigin + time, indexes.get(key)]);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
})();`;
