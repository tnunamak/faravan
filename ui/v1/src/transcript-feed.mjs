import {formatDate} from './dates.mjs';
// The agent transcript as an activity feed. The lender streams the agent's raw JSON events (Claude Code
// stream-json, Codex item events) and plain text lines; this file reads them into the kinds the page draws:
// `message` (the agent's words), `tool` (a command, read, edit or search, with its output) and `text` (a line
// the parser doesn't know, kept as written). Protocol records such as thinking, usage and heartbeats stay out.

const OUTPUT_LIMIT = 20000;

// [past verb, present verb, icon] for each tool the agents use. Anything else reads "Used <name>".
const TOOLS = {
  Bash: ['Ran', 'running', 'terminal'], Read: ['Read', 'reading', 'file'], Write: ['Wrote', 'writing', 'file'],
  Edit: ['Edited', 'editing', 'pencil'], MultiEdit: ['Edited', 'editing', 'pencil'], NotebookEdit: ['Edited', 'editing', 'pencil'],
  Grep: ['Searched', 'searching', 'search'], Glob: ['Searched', 'searching', 'search'], LS: ['Listed', 'listing', 'search'],
  WebFetch: ['Fetched', 'fetching', 'globe'], WebSearch: ['Searched the web', 'searching the web', 'globe'],
  TodoWrite: ['Updated its plan', 'updating its plan', 'list'], Task: ['Asked a helper', 'asking a helper', 'user'], Agent: ['Asked a helper', 'asking a helper', 'user'],
};
// Tools whose result only repeats what the row says ("updated successfully", the file it read); their output shows only on error.
const QUIET_OUTPUT = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite']);

const str = value => typeof value === 'string' ? value : '';
const oneLine = value => str(value).replace(/\s+/g, ' ').trim();
const time = value => { const at = Date.parse(str(value)); return Number.isFinite(at) ? at : null; };

function relative(path, cwd) {
  const text = str(path);
  if (cwd && text.startsWith(cwd + '/')) return text.slice(cwd.length + 1);
  return text.replace(/^\/tmp\/wf-job-[^/]+\//, '');
}
function relativeAll(text, cwd) {
  let out = str(text);
  if (cwd) out = out.split(cwd + '/').join('').split(cwd).join('.');
  return out.replace(/\/tmp\/wf-job-[^/\s"']+\//g, '').replace(/\/tmp\/wf-job-[^/\s"']+/g, '.');
}

function targetOf(name, input = {}, cwd) {
  switch (name) {
    case 'Bash': return relativeAll(str(input.command), cwd);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return relative(input.file_path, cwd);
    case 'NotebookEdit': return relative(input.notebook_path, cwd);
    case 'Grep': case 'Glob': return str(input.pattern);
    case 'LS': return relative(input.path, cwd);
    case 'WebFetch': return str(input.url);
    case 'WebSearch': return str(input.query);
    case 'Task': case 'Agent': return str(input.description);
    case 'TodoWrite': return '';
    default: return Object.values(input || {}).find(v => typeof v === 'string' && v.trim()) || '';
  }
}

function outputText(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > OUTPUT_LIMIT ? '…' + trimmed.slice(-OUTPUT_LIMIT) : trimmed;
}

/** "0:42" / "12s": how long a step took. Under a second it isn't worth saying. */
export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** The agent's words split on `code` spans, so a message can set file names and commands in monospace. */
export function messageParts(text) {
  return str(text).split(/(`[^`\n]+`)/).filter(Boolean).map(part => part.length > 2 && part.startsWith('`') && part.endsWith('`') ? {text: part.slice(1, -1), code: true} : {text: part, code: false});
}

function toolEntry(id, name, input, at, cwd) {
  const [verb, doing, icon] = TOOLS[name] || ['Used ' + name, 'using ' + name, 'zap'];
  const full = targetOf(name, input, cwd);
  return {id, kind: 'tool', tool: name, verb, doing, icon, target: oneLine(full.split('\n')[0]), full: full.trim(), at, output: '', error: false, completed: false, running: true, seconds: null, took: ''};
}

/**
 * The feed for a transcript `{text, truncated, live}`. `zone` sets the clock for entry times.
 * Returns {entries, trimmed, activity}: `trimmed` when the host dropped earlier lines, `activity` the latest step for the
 * status card ({doing, code}) or null.
 */
export function transcriptFeedVM(transcript = '', {truncated = false, live = false, zone} = {}) {
  const entries = [], tools = new Map();
  let cwd = '', lastMessage = '', textRun = null, plainFence = '', n = 0, lastAt = null, lastVisibleOutputAt = null;
  const visibleAt = at => { if (Number.isFinite(at) && (lastVisibleOutputAt === null || at > lastVisibleOutputAt)) lastVisibleOutputAt = at; };
  const push = entry => { if (entry.kind !== 'withheld') visibleAt(entry.at); entries.push(entry); textRun = null; return entry; };
  let withheld=false;
  const privacyNote=()=>{if(!withheld){push({id:'withheld',kind:'withheld',text:'Some output was withheld because it may contain private details',at:null});withheld=true;}};
  const appendPlain = line => {
    if(line.includes('[private details withheld]')){privacyNote();return;}
    if(textRun)textRun.text+='\n'+line;
    else {push({id:'text-'+n++,kind:'text',text:line,at:null});textRun=entries.at(-1);}
  };
  const lines = String(transcript ?? '').split('\n');
  lines.forEach((line, index) => {
    const fence=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(plainFence){appendPlain(line);if(fence&&fence[1][0]===plainFence[0]&&fence[1].length>=plainFence.length)plainFence='';return;}
    if(fence){appendPlain(line);plainFence=fence[1];return;}
    if (!line.trim()) { if (textRun) textRun.text += '\n' + line; return; }
    let e;
    try { e = JSON.parse(line); } catch {
      // A trimmed transcript starts mid-line; a broken JSON record is never shown as text.
      if ((truncated && index === 0) || /^\s*(?:\{\s*"|\[\s*["{\d])/.test(line)) return;
      appendPlain(line);
      return;
    }
    if (!e || typeof e !== 'object') return;
    const at = time(e.timestamp);
    if (Number.isFinite(at) && (lastAt === null || at > lastAt)) lastAt = at;
    if(e.type==='transcript.withheld'||e.omitted===true){privacyNote();return;}
    if (e.type === 'system' && e.subtype === 'init') { cwd = str(e.cwd); return; }
    if ((e.type === 'assistant' || e.type === 'user') && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if(block?.type==='text'&&str(block.text).includes('[private details withheld]')){privacyNote();continue;}
        if (block?.type === 'text' && str(block.text).trim()) { const text = block.text.trim(); if (e.type === 'assistant') lastMessage = text; push({id: 'm-' + n++, kind: 'message', role: e.type, text, parts: messageParts(text), at}); }
        if (block?.type === 'tool_use' && typeof block.name === 'string') tools.set(block.id, push(toolEntry(block.id || 't-' + n++, block.name, block.input, at, cwd)));
        if (block?.type === 'tool_result') {
          const rawOutput = outputText(block.content);
          if (rawOutput.includes('[private details withheld]') || block.omitted === true) {
            const tool = tools.get(block.tool_use_id);
            if (tool) { tool.running = false; tool.completed = true; tool.error = block.is_error === true; tool.output = ''; }
            privacyNote(); continue;
          }
          let tool = tools.get(block.tool_use_id);
          if (!tool) tool = push({...toolEntry('orphan-' + n++, '', {}, at, cwd), orphan: true, verb: 'Tool result — earlier step unavailable'});
          tool.running = false;
          tool.completed = true;
          visibleAt(at);
          tool.error = block.is_error === true;
          const output = relativeAll(rawOutput, cwd);
          tool.output = QUIET_OUTPUT.has(tool.tool) && !tool.error ? '' : output;
          if (Number.isFinite(at) && Number.isFinite(tool.at)) tool.took = durationLabel(at - tool.at);
        }
      }
      return;
    }
    if (e.type === 'tool_progress') { const tool = tools.get(e.parent_tool_use_id); if (tool && Number.isFinite(e.elapsed_time_seconds)) tool.seconds = e.elapsed_time_seconds; return; }
    if (e.type === 'result') {
      const words = str(e.result).trim();
      if(words.includes('[private details withheld]')){privacyNote();return;}
      if (e.is_error === true || (e.subtype && e.subtype !== 'success')) push({id: 'r-' + n++, kind: 'text', error: true, text: words || 'The agent stopped with an error.', at});
      else if (words && words !== lastMessage) push({id: 'r-' + n++, kind: 'message', text: words, parts: messageParts(words), at});
      return;
    }
    // Codex item events.
    const item = e.item;
    if(str(item?.text||item?.message||e.message).includes('[private details withheld]')){privacyNote();return;}
    if ((e.type === 'item.started' || e.type === 'item.completed' || e.type === 'item.updated') && item && typeof item === 'object') {
      if (item.type === 'agent_message' && e.type === 'item.completed' && str(item.text).trim()) { lastMessage = item.text.trim(); push({id: 'm-' + n++, kind: 'message', text: lastMessage, parts: messageParts(lastMessage), at}); }
      if (item.type === 'command_execution') {
        let tool = tools.get(item.id);
        if (!tool) tools.set(item.id, tool = push({...toolEntry(item.id || 'c-' + n++, 'Bash', {command: item.command}, at, cwd)}));
        if (e.type === 'item.completed') {
          tool.running = false;
          tool.completed = true;
          visibleAt(at);
          tool.output = relativeAll(outputText(str(item.aggregated_output)), cwd);
          tool.error = Number.isFinite(item.exit_code) ? item.exit_code !== 0 : item.status === 'failed';
        }
      }
      if (item.type === 'file_change' && e.type === 'item.completed') {
        const paths = (Array.isArray(item.changes) ? item.changes : []).map(c => relative(c?.path, cwd)).filter(Boolean);
        push({...toolEntry(item.id || 'f-' + n++, 'Edit', {}, at, cwd), target: paths.join(', '), full: paths.join('\n'), running: false, completed: true});
      }
      if (item.type === 'error' && str(item.message)) push({id: 'e-' + n++, kind: 'text', error: true, text: item.message, at});
      return;
    }
    if (e.type === 'error' && str(e.message)) push({id: 'e-' + n++, kind: 'text', error: true, text: e.message, at});
  });
  // A finished transcript has nothing running, even if a result never arrived.
  if (!live) for (const tool of tools.values()) tool.running = false;
  if(withheld&&entries.length===1)entries[0].text='Output was withheld because it may contain private details';
  stampTimes(entries, zone);
  const lastTool = [...entries].reverse().find(entry => entry.kind === 'tool');
  const activity = live && lastTool ? {doing: toolLabel(lastTool).toLowerCase(), code: lastTool.target,
    ...(lastTool.running ? {since: lastTool.at, seconds: lastTool.seconds} : {})} : null;
  return {entries, trimmed: truncated === true, activity, lastAt, lastContactAt: lastAt, lastVisibleOutputAt};
}

export const elapsedTime = seconds => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');

/** Job status uses readable minute durations; step ages use readable seconds or minutes too. */
export function jobTimingLine({now, queuedAt, startedAt, stopsAt, lastOutputAt, zone} = {}) {
  const timestamp = value => typeof value === 'number' ? value : Date.parse(typeof value === 'string' ? value : '');
  const queued = timestamp(queuedAt), started = timestamp(startedAt), stop = timestamp(stopsAt);
  const lastOutput = timestamp(lastOutputAt);
  const elapsed = Number.isFinite(started) && Number.isFinite(now) ? Math.max(0, Math.floor((now - started) / 1000)) : NaN;
  const waitingSeconds = !Number.isFinite(started) && Number.isFinite(queued) && Number.isFinite(now) ? Math.max(0, Math.floor((now - queued) / 1000)) : NaN;
  const quietSeconds = Number.isFinite(lastOutput) && Number.isFinite(now) ? Math.floor((now - lastOutput) / 1000) : NaN;
  const parts = [];
  if (Number.isFinite(waitingSeconds)) parts.push(waitingSeconds < 60 ? 'waiting under 1 min' : 'waiting ' + Math.floor(waitingSeconds / 60) + ' min');
  if (Number.isFinite(elapsed)) {
    const age = (elapsed < 60 ? elapsed + ' s' : Math.floor(elapsed / 60) + ' min') + ' ago';
    let clock = null;
    try { clock = formatDate(started,'clock',{zone}); } catch {}
    parts.push(clock ? 'Started ' + clock + ' (' + age + ')' : 'Started ' + age);
  }
  if (Number.isFinite(stop)) {
    try { parts.push('Time limit ' + formatDate(stop,'clock',{zone})); } catch {}
  }
  if (Number.isFinite(quietSeconds) && quietSeconds > 60) parts.push('Last visible output ' + Math.floor(quietSeconds / 60) + ' min ago');
  // The line describes observed times, never a guarantee of current execution.
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Seconds a running step has run: from its start time, or the agent's own heartbeat when that is later or the only clue. */
export function runningSeconds({since, seconds} = {}, now) {
  const fromStart = Number.isFinite(since) && Number.isFinite(now) ? Math.max(0, Math.floor((now - since) / 1000)) : null;
  return Number.isFinite(seconds) && !(fromStart >= seconds) ? seconds : fromStart;
}

/**
 * A started step’s elapsed age and contact silence, without asserting current execution.
 */
export function runningVM(entry, {now, lastAt} = {}) {
  const seconds = runningSeconds({since: entry?.at}, now);
  const quiet = Number.isFinite(lastAt) && Number.isFinite(now) ? Math.floor((now - lastAt) / 1000) : seconds;
  return {timer: Number.isFinite(seconds) ? 'Started ' + (seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min') + ' ago' : 'Start time unavailable',
    quiet: quiet > 60 ? 'No update for ' + Math.floor(quiet / 60) + ' min. Current activity is unconfirmed.' : ''};
}

// Every message and note shows its time; tool rows show their duration instead. Each timed entry keeps the full time for its tooltip.
function stampTimes(entries, zone) {
  if (!formatDate(0, 'clock', {zone})) return;
  const clock = {format: at => formatDate(at, 'clock', {zone})}, full = {format: at => formatDate(at, 'clockSeconds', {zone})};
  for (const entry of entries) {
    if (!Number.isFinite(entry.at)) { entry.time = ''; entry.timeTitle = ''; continue; }
    const label = clock.format(entry.at);
    entry.timeTitle = full.format(entry.at);
    entry.time = entry.kind === 'tool' ? '' : label;
  }
}

// ---- follow: the feed keeps to the newest entry while the reader is at the bottom ----

/** Within this many pixels of the end counts as "at the bottom". */
export const FOLLOW_SLACK = 32;
export function atBottom({scrollTop = 0, scrollHeight = 0, clientHeight = 0} = {}, slack = FOLLOW_SLACK) {
  return scrollHeight - scrollTop - clientHeight <= slack;
}
/** After the reader scrolls: follow while they're at the bottom; offer "Jump to latest" only while the job runs. */
export function followVM(metrics, live) {
  const following = atBottom(metrics);
  return {following, jump: live === true && !following};
}

// Snapshot/contact time is not evidence of visible output.
export function statusLastOutputAt(feed,lastOutputAt) {
  const observed = Object.hasOwn(feed,'lastVisibleOutputAt') ? feed.lastVisibleOutputAt : lastOutputAt;
  return Number.isFinite(observed) ? observed : null;
}

/** Completion is evidence from a matching result, not a terminal job flag. */
export function toolLabel(entry) {
  if (entry.orphan) return 'Tool result — earlier step unavailable';
  if (entry.completed) return entry.error ? 'Failed while ' + entry.doing : entry.verb;
  return 'Started ' + entry.doing;
}
// Live is a claim about the last confirmed transcript read. No live read inside this window, or no read at all, is not live.
export const LIVE_ACTIVITY_WINDOW_MS = 30000;
/** The freshness feedFreshness reads, from a live transcript read that completed at observedAt (ms). */
export function liveFreshness({connected, observedAt} = {}) {
  const at = Number.isFinite(observedAt) ? observedAt : null;
  return {connected: connected === true, observedAt: at, validUntil: at === null ? null : at + LIVE_ACTIVITY_WINDOW_MS};
}
export function feedFreshness({connected, observedAt, validUntil} = {}, now) {
  return connected === true && Number.isFinite(observedAt) && Number.isFinite(validUntil) &&
    Number.isFinite(now) && observedAt <= now && now <= validUntil && observedAt <= validUntil;
}
/** A timestamped agent update inside the window: the only evidence that the agent is doing something now. */
export function agentUpdateFresh(feed, now) {
  return feedFreshness(liveFreshness({connected: true, observedAt: feed?.lastAt}), now);
}
export function feedEvidenceLabels(feed, now) {
  const age = at => Number.isFinite(at) && Number.isFinite(now) && at <= now
    ? Math.floor((now - at) / 60000) + ' min ago' : 'unavailable';
  return ['Last agent update ' + age(feed.lastAt), 'Last visible output ' + age(feed.lastVisibleOutputAt)];
}
export function feedAnnouncement(previous, current) {
  if (!previous) return '';
  if (current.connected === false && previous.connected !== false) return 'Connection lost';
  if (current.question && !previous.question) return 'The run ended with a question';
  if (current.output !== previous.output) return 'New agent output available';
  return '';
}
