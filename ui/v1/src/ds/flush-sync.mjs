import {options} from 'preact';

// Paints the state `fn` sets before it returns, so pending feedback shows within the event that caused it.
// This is preact/compat's flushSync without importing compat: compat's vnode hook rebuilds every element's
// props, which moves `class` after the other attributes in all markup.
export function flushSync(fn) {
  const prev = options.debounceRendering;
  options.debounceRendering = cb => cb();
  try { return fn(); }
  finally { options.debounceRendering = prev; }
}
