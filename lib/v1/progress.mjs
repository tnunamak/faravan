// Coarse progress steps for the optional progress channel (docs/protocol/progress.schema.json).
// A step is built from the kind of thing the agent did, never from its content: no file
// contents, no command lines, no prompt text. A path is named only when it passes the same
// secret-file rules the source upload uses; anything else is described without a name.
import { sourceFileOmission } from './secret-files.mjs';

export const PROGRESS_MIN_INTERVAL_MS = 15000;
export const PROGRESS_MAX_STEPS = 40;
const STEP_MAX = 120;

const TOOL_VERBS = new Map([
  ['read', 'Reading'], ['view', 'Reading'], ['edit', 'Editing'], ['multiedit', 'Editing'], ['write', 'Writing'], ['notebookedit', 'Editing'],
]);
const TOOL_GENERIC = new Map([
  ['bash', 'Running a command'], ['shell', 'Running a command'], ['grep', 'Searching the code'], ['glob', 'Looking for files'],
  ['webfetch', 'Reading a web page'], ['websearch', 'Searching the web'], ['task', 'Working with a helper agent'],
  ['todowrite', 'Planning the next steps'],
]);

// A short relative path is fine to name; absolute, odd or secret paths are not.
function namedPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.replace(/^\.\//, '');
  if (!path || path.length > 80 || path.startsWith('/') || path.startsWith('~') || path.includes('..') ||
      /[\u0000-\u001f\u007f\s]/.test(path) || /[;&|`$<>"'\\]/.test(path) || sourceFileOmission(path,{tracked:true})) return null;
  return path;
}
const clip = text => { const chars = [...text]; return chars.length > STEP_MAX ? chars.slice(0, STEP_MAX - 1).join('') + '…' : text; };

/** One agent tool use, as {name, input}, to one coarse sentence (or null). */
export function stepForTool(name, input) {
  const key = String(name ?? '').toLowerCase();
  const verb = TOOL_VERBS.get(key);
  if (verb) {
    const path = namedPath(input?.file_path ?? input?.path ?? input?.notebook_path);
    return clip(path ? verb + ' ' + path : verb === 'Reading' ? 'Reading a file' : verb === 'Writing' ? 'Writing a file' : 'Editing a file');
  }
  return TOOL_GENERIC.get(key) ?? null;
}

/** Steps from one transcript line (Claude stream-json or Codex --json); unknown shapes give none. */
export function stepsFromLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return []; }
  if (!event || typeof event !== 'object') return [];
  const out = [];
  const content = event.message?.content;
  if (event.type === 'assistant' && Array.isArray(content))
    for (const block of content) if (block?.type === 'tool_use') { const step = stepForTool(block.name, block.input); if (step) out.push(step); }
  const item = event.item;
  if (event.type === 'item.started' || event.type === 'item.completed') {
    if (item?.type === 'command_execution' && event.type === 'item.started') out.push('Running a command');
    else if (item?.type === 'file_change' && event.type === 'item.completed') {
      const first = Array.isArray(item.changes) ? namedPath(item.changes[0]?.path) : null;
      out.push(first ? 'Editing ' + first : 'Editing files');
    }
  }
  return out;
}

/**
 * Feeds transcript chunks; calls send({step, kind}) for at most one step every minIntervalMs
 * and maxSteps per run. Steps that arrive between sends are dropped, not queued: the channel
 * shows where the agent is now. send errors are swallowed; progress never affects the job.
 *
 * stage(name, elapsedS) sends {stage, elapsed_s} (P8b). A stage is a change of state, so it is
 * not dropped for the interval: it waits until the interval has passed. It shares the queue,
 * the interval and the cap with steps, which is how the coordinator counts them too.
 */
export function createProgressReporter({send, now = Date.now, minIntervalMs = PROGRESS_MIN_INTERVAL_MS, maxSteps = PROGRESS_MAX_STEPS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.())} = {}) {
  let buffer = '', last = -Infinity, sent = 0, previous = null, chain = Promise.resolve();
  // The closing entry ends the run: a stage that is still waiting for its interval is no longer true, so it is skipped.
  let closed = false, close;
  const closing = new Promise(resolve => { close = resolve; });
  const emit = (step, kind) => {
    chain = chain.then(() => send({step, kind})).catch(() => {});
  };
  return {
    feed(chunk) {
      buffer += String(chunk ?? '');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        for (const step of stepsFromLine(line)) {
          const t = now();
          if (sent >= maxSteps - 1 || t - last < minIntervalMs || step === previous) continue;
          last = t; sent++; previous = step; emit(step, 'step');
        }
      }
      if (buffer.length > 1048576) buffer = '';
    },
    stage(name, elapsedS) {
      if (sent >= maxSteps - 1 || !Number.isSafeInteger(elapsedS) || elapsedS < 0) return chain;
      sent++;
      const wait = Math.max(0, last + minIntervalMs - now());
      last = now() + wait; // steps fed while this stage waits are dropped, as the interval says
      chain = chain.then(async () => {
        if (wait) { await Promise.race([sleep(wait), closing]); if (closed) return; }
        await send({stage: name, elapsed_s: elapsedS});
      }).catch(() => {});
      return chain;
    },
    // The closing entry is exempt from the interval but still counts toward the cap.
    finish(kind, step) { closed = true; close(); if (sent < maxSteps) { sent++; emit(step, kind); } return chain; },
    settled: () => chain,
  };
}
