import { ISOLATION_TARGETS } from '../../lib/v1/isolation-check.mjs';

export const isolationResponseRow = (host, control = false, status = control ? 404 : 403) => ({
  host, protocol: control ? 'https:' : 'http:', port: control ? 443 : 80,
  observation: 'response', status, tlsAuthorized: control, error: null,
});

export const isolationReport = (controlHost = 'api.anthropic.com', gateway = '172.17.0.1') => ({
  schema: 1, completed: true, gateway, control: isolationResponseRow(controlHost, true),
  targets: [...new Set([...ISOLATION_TARGETS, ...(gateway ? [gateway] : [])])].map(host => isolationResponseRow(host)),
});

export const isolationPolicy = (report, sandbox_id = 'sb-1') => ({
  allowed: [{ sandbox_id, host: report.control.host }],
  blocked: report.targets.map(row => ({ sandbox_id, host: row.host })),
});
