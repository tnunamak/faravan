// "See what we send" (#/you/data/telemetry): the page model for GET /api/telemetry/preview. The body of each item is
// the exact JSON text that was or will be uploaded; this module never parses, trims or reformats it, so Copy and
// Download hand over the same bytes the inspector shows.
import {PRODUCT} from '../../../lib/v1/product.mjs';
import {formatBytes, formatTime} from './helpers.mjs';
import {stateSentence} from './telemetry-model.mjs';

const STATE_WORD = {queued: 'Waiting to send', sent: 'Sent', rejected: 'Rejected'};
const STREAM_WORD = {counts: 'Counts', diagnostics: 'Diagnostics', quota: 'Allowance week'};
const count = (n, noun) => `${n} ${noun}`;

export const downloadName = (item, index = 0) => `${PRODUCT.slug}-report-${item.stream}-${String(item.at).replace(/[^0-9A-Za-z]+/g, '-').replace(/-+$/, '')}-${index + 1}.json`;

export function previewModel(output, {format = formatTime} = {}) {
  const state = output?.state ?? {}, items = Array.isArray(output?.items) ? output.items : [];
  const unavailable = state.reason?.kind === 'unavailable';
  const queued = state.queued ?? {};
  const waiting = ['counts', 'diagnostics', 'quota'].reduce((sum, key) => sum + (Number(queued[key]) || 0), 0);
  const rows = items.map((item, index) => ({
    key: index + ':' + item.stream + ':' + item.at,
    stream: item.stream, streamLabel: STREAM_WORD[item.stream] ?? item.stream,
    state: item.state, stateLabel: STATE_WORD[item.state] ?? item.state,
    at: item.at, time: format(item.at), bytes: item.bytes, size: formatBytes(item.bytes),
    status: item.status ?? null, statusLabel: item.status === null || item.status === undefined ? 'no answer yet' : String(item.status),
    body: item.body, filename: downloadName(item, index),
    line: [STREAM_WORD[item.stream] ?? item.stream, STATE_WORD[item.state] ?? item.state, format(item.at), formatBytes(item.bytes),
      item.status === null || item.status === undefined ? 'no answer yet' : 'status ' + item.status].join(' · '),
  }));
  return {
    sentence: unavailable ? 'Report information is unavailable on this computer.' : stateSentence(state),
    env: state.reason?.kind === 'env',
    off: !unavailable && state.effective === 'off',
    unavailable,
    queuedLine: unavailable ? 'Queue information is unavailable.' : waiting
      ? 'Waiting to send: ' + [count(Number(queued.counts) || 0, 'counts'), count(Number(queued.diagnostics) || 0, 'diagnostics'), count(Number(queued.quota) || 0, 'allowance weeks')].join(', ') +
        (Number.isFinite(state.queued_bytes) ? ' (' + formatBytes(state.queued_bytes) + ')' : '') + '.'
      : 'Nothing is waiting to send.',
    emptyLine: rows.length ? null : unavailable ? 'Locally retained reports could not be read.' : 'No locally retained reports to show.',
    items: rows,
  };
}
