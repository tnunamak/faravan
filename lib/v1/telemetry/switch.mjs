// The person's off-switches and the request headers that carry them. Small and dependency-free, so the CLI, the MCP
// server and the ops layer can use it without loading the rest of telemetry (design §4.5).
import { PRODUCT } from '../product.mjs';

export const SURFACE_HEADER = 'faravan-surface';
export const OFF_HEADER = 'faravan-telemetry';
const OFF_VALUES = new Set(['', '0', 'false']);

/**
 * The name of the environment switch that turns telemetry off in `env`, or null. The product's own variable is read
 * first; the legacy one only while the product's is unset. DO_NOT_TRACK always counts.
 */
export function envSwitch(env = {}) {
  // The legacy variable is a literal, not PRODUCT's: PRODUCT is bundled into the web UI and carries only the current brand.
  const product = [`${PRODUCT.envPrefix}_NO_TELEMETRY`, 'FARAVAN_NO_TELEMETRY'].find(name => env[name] !== undefined);
  for (const name of [product, 'DO_NOT_TRACK']) {
    const value = name && env[name];
    if (typeof value === 'string' && !OFF_VALUES.has(value.trim().toLowerCase())) return name;
  }
  return null;
}

/** Headers a CLI or MCP client adds to every call: where it comes from, and `off` when an environment switch is set. */
export const clientHeaders = (env, surface) => ({
  ...(surface ? {[SURFACE_HEADER]: surface} : {}),
  ...(envSwitch(env) ? {[OFF_HEADER]: 'off'} : {}),
});

/** The request-scope restriction of a request's headers: the client switch, or Sec-GPC: 1 from a browser. */
export const scopeOf = headers => ({off: headers?.[OFF_HEADER] === 'off' || headers?.['sec-gpc'] === '1'});

/** The headers an ops call forwards on its inner REST call, so the occurrence there carries the right surface and scope. */
export const forwardedHeaders = headers => ({
  ...Object.fromEntries([SURFACE_HEADER].filter(name => typeof headers?.[name] === 'string').map(name => [name, headers[name]])),
  // Any way of asking to be left out (the client switch, Sec-GPC) reaches the inner call as the one header it understands.
  ...(scopeOf(headers).off ? {[OFF_HEADER]: 'off'} : {}),
});
