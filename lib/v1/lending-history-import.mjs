/**
 * Weekly import scores use this contract:
 * {resource, account_week_id, week_start, score, censored, source:'import', coverage_ratio}.
 * resource keeps its claude: or codex: prefix so the account-scoped store adapter can route it. account_week_id is the
 * provider reset epoch in Unix milliseconds; week_start is the start of that reset interval.
 * A censored row always has score +Infinity. Meter periods are complete account-week intervals for one resource,
 * with null meter_points when no comparable meter evidence exists. The one adapter below maps these rows to the
 * persisted lending-history API. Separate usageSamples retain timestamped per-session priced events; they are not
 * K increments until a caller groups complete data into predeclared, nonoverlapping fixed-exposure slots.
 */
import {MEASURED_LABEL, measureKappa} from './lending-kappa-measure.mjs';
import {accountHash} from './lending-log-attribution.mjs';
import { priceListUsd } from './lending-meter.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, opendirSync, statSync, lstatSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, sep } from 'node:path';
import { createLendingHistory } from './lending-history.mjs';
import { createLendingLedger } from './lending-ledger.mjs';

const parsedLog = Symbol('local parsed usage');
const localLogCache = new Map(); // Usage metadata only; never retain session contents.
let cachedUsageRows = 0;
const MAX_CACHED_USAGE_ROWS = 50_000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MAX_OPEN_WINDOW_HISTORY_WEEKS = 26;
const DEFAULT_MINIMUM_COVERAGE = 0.9;
const DEFAULT_HISTORY_WORKER_TIMEOUT_MS = 30_000;
const isImport = source => source === 'import' || source === 'import-open-window';

function clearParsedLogCache() {
  localLogCache.clear();
  cachedUsageRows = 0;
}

function cacheParsedLog(path, entry) {
  const previous = localLogCache.get(path);
  if (previous) cachedUsageRows -= previous.parsed.usage.length;
  localLogCache.delete(path);
  if (entry.parsed.usage.length > MAX_CACHED_USAGE_ROWS || entry.parsed.usage.some(row =>
    typeof row.message_id !== 'string' || !row.message_id.length || row.message_id.length > 512 ||
    typeof row.model !== 'string' || !row.model.length || row.model.length > 128)) return;
  localLogCache.set(path, entry);
  cachedUsageRows += entry.parsed.usage.length;
  while (cachedUsageRows > MAX_CACHED_USAGE_ROWS || localLogCache.size > 256) {
    const oldestItem = localLogCache.entries().next().value;
    if (!oldestItem) break;
    const [oldestPath, oldest] = oldestItem;
    localLogCache.delete(oldestPath);
    cachedUsageRows -= oldest.parsed.usage.length;
  }
}

function historyError(code, message) {
  return Object.assign(new Error(message), {code});
}

function canContinue(shouldContinue) {
  try { return Boolean(shouldContinue()); }
  catch { return false; }
}

function accountId(value, provider) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value))
    throw new TypeError(`${provider} account is invalid`);
  return value;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function count(value) {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function claudeTokens(usage) {
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  if ([input, output, read, write].some(value => value === null)) return null;
  const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const has5m = split && Object.hasOwn(split, 'ephemeral_5m_input_tokens');
  const has1h = split && Object.hasOwn(split, 'ephemeral_1h_input_tokens');
  const write5 = has5m ? count(split.ephemeral_5m_input_tokens) : null;
  const write1 = has1h ? count(split.ephemeral_1h_input_tokens) : null;
  if ((has5m && write5 === null) || (has1h && write1 === null)) return null;
  if (write5 > write || write1 > write) return null;
  const cacheWrite1h = has1h ? write1 : has5m ? write - write5 : write;
  const cacheWrite5m = has5m ? write5 : write - cacheWrite1h;
  if (cacheWrite1h + cacheWrite5m !== write) return null;
  return {fresh_input:input, cache_read:read, cache_write_5m:cacheWrite5m,
    cache_write_1h:cacheWrite1h, output, reasoning:0};
}

function parseJsonLines(text) {
  const records = [];
  let malformedLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { malformedLines++; }
  }
  return {records, malformedLines};
}

function jsonlFiles(root, accept, budget) {
  const files = [], pending = [root];
  try {
    if (lstatSync(dirname(root)).isSymbolicLink() || lstatSync(root).isSymbolicLink())
      throw historyError('history_changed', 'History root is a symlink');
  } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  while (pending.length) {
    const current = pending.pop();
    let dir;
    try { dir = opendirSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      let entry;
      while ((entry = dir.readSync()) !== null) {
        if (++budget.entries > 4096) throw historyError('history_size_limit', 'History discovery limit exceeded');
        const path = join(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && accept(entry.name)) {
          if (++budget.files > 1024) throw historyError('history_size_limit', 'History discovery limit exceeded');
          files.push(path);
        } else if (entry.isSymbolicLink() || accept(entry.name)) {
          throw historyError('history_changed', 'History contains a link or special file');
        }
      }
    } finally { dir.closeSync(); }
  }
  return files;
}

/** Read only the two local session-log trees, one file at a time, after the caller obtains owner consent. */
export function* readLocalAgentSessionLogs(homeDir, {incremental = false} = {}) {
  if (typeof homeDir !== 'string' || !homeDir) throw new TypeError('homeDir is required');
  const roots = [
    {provider:'claude', account:'claude', path:join(homeDir, '.claude', 'projects'), accept:name => name.endsWith('.jsonl')},
    {provider:'codex', account:'codex', path:join(homeDir, '.codex', 'sessions'), accept:name => /^rollout-.+\.jsonl$/.test(name)},
  ];
  const budget = {entries:0, files:0};
  const paths = roots.flatMap(root => jsonlFiles(root.path, root.accept, budget).sort().map(path => ({root,path})));
  const seenFiles = new Set();
  let totalBytes = 0, totalRecords = 0;
  for (const {root,path} of paths) {
    const stat = statSync(path), identity = `${stat.dev}:${stat.ino}`;
    if (seenFiles.has(identity)) continue;
    seenFiles.add(identity);
    if (stat.size > 64 * 1024 * 1024 || totalBytes + stat.size > 256 * 1024 * 1024)
      throw historyError('history_size_limit', 'History size limit exceeded');
    totalBytes += stat.size;
    const readContents = () => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw historyError('history_changed', 'History file changed');
        const chunks = []; let bytes = 0, lineBytes = 0, records = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(64 * 1024);
          const count = readSync(fd, chunk, 0, chunk.length, null);
          if (!count) break;
          bytes += count;
          if (bytes > stat.size) throw historyError('history_changed', 'History file changed');
          let start = 0;
          for (let index = 0; index < count; index++) {
            if (chunk[index] !== 10) continue;
            lineBytes += index - start;
            if (lineBytes > 1024 * 1024) throw historyError('history_line_limit', 'History line size limit exceeded');
            if (lineBytes > 0 && ++records > 25000) throw historyError('history_record_limit', 'History record limit exceeded');
            lineBytes = 0; start = index + 1;
          }
          lineBytes += count - start;
          if (lineBytes > 1024 * 1024) throw historyError('history_line_limit', 'History line size limit exceeded');
          chunks.push(chunk.subarray(0, count));
        }
        if (lineBytes > 0 && ++records > 25000) throw historyError('history_record_limit', 'History record limit exceeded');
        totalRecords += records;
        if (totalRecords > 200000) throw historyError('history_record_limit', 'History record limit exceeded');
        const end = fstatSync(fd);
        if (bytes !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs)
          throw historyError('history_changed', 'History file changed');
        return {contents:Buffer.concat(chunks, bytes).toString('utf8'),records};
      } finally { closeSync(fd); }
    };
    if (!incremental) {
      yield {provider:root.provider, account:root.account, source:path, contents:readContents().contents};
      continue;
    }
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let cached = localLogCache.get(path);
    if (!cached || cached.fingerprint !== fingerprint || !Number.isInteger(cached.records)) {
      const {contents, records} = readContents();
      const parsed = root.provider === 'claude' ? parseClaudeSessionLogForAccount(contents, root.account)
        : parseCodexRolloutLogForAccount(contents, root.account);
      cached = {fingerprint, parsed, records};
      cacheParsedLog(path, cached);
      // Keep the public reader contract for the first read; importer consumes private parsed metadata.
      yield {provider:root.provider, account:root.account, source:path, contents, [parsedLog]:cached.parsed};
    } else {
      totalRecords += cached.records;
      if (totalRecords > 200000) throw historyError('history_record_limit', 'History record limit exceeded');
      // Preserve the public read contract: only the internal incremental reader uses cached metadata.
      yield {provider:root.provider, account:root.account, source:path, contents:'', [parsedLog]:cached.parsed};
    }
  }
}

/** Parse local logs away from the event loop; wait for the caller's go/no-go between files. */
export async function readLocalAgentSessionLogsInWorker(homeDir, {logRoots = null, meterPeriods = [], currentWindows = [], shouldContinue = () => true,
  timeoutMs = DEFAULT_HISTORY_WORKER_TIMEOUT_MS, onProgress, workerUrl = new URL('./lending-history-worker.cjs', import.meta.url)} = {}) {
  if (typeof homeDir !== 'string' || !homeDir) throw new TypeError('homeDir is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const cached = Object.fromEntries([...localLogCache].map(([path, value]) => [path, {fingerprint:value.fingerprint}]));
  let worker;
  try {
    worker = new Worker(workerUrl, {
      workerData:{homeDir,cached,importerUrl:import.meta.url,
        logRoots:Array.isArray(logRoots) ? logRoots.map(({provider, path}) => ({provider, path})) : null},
    });
  } catch {
    return {logs:[],aborted:false,incomplete:true,errorCode:'history_worker_crashed',skippedFiles:0,
      skippedBytes:0,skippedLines:0,skippedRows:0,workerExited:false};
  }
  worker.unref();
  const logs = [];
  let aborted = false;
  let cancellationMonitor;
  let watchdog;
  let workerExitCode;
  let filesSeen = 0, filesDone = 0, progressFile = null;
  let partialLog = null;
  let result;
  try {
    await new Promise((resolve,reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      const incomplete = (errorCode, errorMessage) => {
        if (stats.currentFile) {
          if (!stats.skippedFilePaths.includes(stats.currentFile)) stats.skippedFiles++;
          stats.skippedFilePaths = [...new Set([...stats.skippedFilePaths, stats.currentFile])];
          if (stats.currentFileMetadata) stats.droppedItems.push(stats.currentFileMetadata);
          stats.currentFile = null;
          stats.currentFileMetadata = null;
        }
        result = {logs,aborted:false,incomplete:true,...(errorCode ? {errorCode} : {}),...(errorMessage ? {errorMessage} : {}),...stats};
        finish();
      };
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { incomplete('history_worker_timeout'); worker.terminate(); }, timeoutMs);
        watchdog.unref();
      };
      cancellationMonitor = setInterval(() => {
        if (!canContinue(shouldContinue)) {
          aborted = true;
          result = {logs,aborted,incomplete:false,...stats};
          finish();
        }
      },50);
      cancellationMonitor.unref();
      const stats = {skippedFiles:0,skippedBytes:0,skippedLines:0,skippedRows:0,skippedFilePaths:[],droppedItems:[]};
      resetWatchdog();
      worker.on('message', message => {
        if (message.type === 'error') { Object.assign(stats,message.stats ?? {}); incomplete('history_worker_error',message.message); return; }
        if (message.type === 'stats') { Object.assign(stats,message.stats ?? {}); return; }
        if (message.type === 'progress') {
          resetWatchdog();
          if (message.file) { filesSeen++; progressFile = message.file; }
          else if (progressFile) { filesDone++; progressFile = null; }
          stats.currentFile = message.file ?? null;
          stats.currentFileMetadata = message.metadata ?? null;
          try { onProgress?.({file:stats.currentFile,filesSeen,filesDone}); } catch {}
          if (message.file) worker.postMessage({type:'started'});
          return;
        }
        if (message.type === 'done') { resetWatchdog(); Object.assign(stats,message.stats ?? {}); result = {logs,aborted,
          incomplete:message.stats?.incomplete === true,...stats}; finish(); return; }
        if (message.type === 'cached') {
          resetWatchdog();
          const cachedFile = localLogCache.get(message.file);
          if (cachedFile?.fingerprint === message.fingerprint && cachedFile.parsed.usage.length <= message.rowLimit) {
            if (!canContinue(shouldContinue)) {
              aborted = true;
              worker.postMessage({type:'cached',stop:true});
              return;
            }
            logs.push({provider:message.provider,account:message.account,source:message.file,
              mtimeMs:message.mtimeMs,parsed:cachedFile.parsed});
            const proceed = canContinue(shouldContinue);
            aborted ||= !proceed;
            worker.postMessage({type:'cached',found:true,rowCount:cachedFile.parsed.usage.length,
              skippedLines:cachedFile.parsed.skippedLines ?? 0,skippedRows:cachedFile.parsed.skippedRows ?? 0,
              malformedLines:cachedFile.parsed.malformedLines ?? 0,proceed});
            return;
          }
          worker.postMessage({type:'cached',found:false});
          return;
        }
        if (message.type !== 'file' && message.type !== 'fileChunk') return;
        resetWatchdog();
        if (!canContinue(shouldContinue)) { aborted = true; worker.postMessage({type:'continue',value:false}); return; }
        if (!partialLog) { partialLog=message.log; logs.push(partialLog); }
        else if (message.replace) { partialLog.parsed=message.log.parsed; }
        else { partialLog.parsed.usage.push(...message.log.parsed.usage); }
        if (message.provisional) {
          try { onProgress?.({file:message.file,filesSeen,filesDone,rowsReceived:partialLog.parsed.usage.length}); } catch {}
        }
        if (message.type === 'file') {
          stats.currentFile = null;
          cacheParsedLog(message.file,{fingerprint:message.fingerprint,parsed:partialLog.parsed});
          partialLog = null;
        }
        const proceed = canContinue(shouldContinue);
        worker.postMessage({type:'continue',value:proceed});
        if (!proceed) aborted = true;
      });
      worker.once('error',error => incomplete('history_worker_crashed',error.message));
      worker.once('exit',code => {
        workerExitCode = code;
        if (!settled) incomplete(code === 0 ? 'history_worker_exited_early' : 'history_worker_crashed');
      });
    });
  } finally {
    clearInterval(cancellationMonitor);
    clearTimeout(watchdog);
    workerExitCode = await worker.terminate();
  }
  return {...result,workerExited:Number.isInteger(workerExitCode)};
}

function importedSessionId(provider, source, contents, usage) {
  const firstTimestamp = usage.reduce((first, row) => row.at === null ? first
    : first === null ? row.at : Math.min(first, row.at), null);
  const sourceId = typeof source === 'string' && source ? source
    : createHash('sha256').update(contents).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify([provider, sourceId, firstTimestamp])).digest('hex');
  return `session-${digest}`;
}

function sameClaudeInputUsage(a, b) {
  // Output and timestamps evolve across content blocks of the same response.
  // The normalized cache split also fixes the total cache-creation count.
  return a.model === b.model &&
    ['fresh_input', 'cache_read', 'cache_write_5m', 'cache_write_1h']
      .every(key => a.tokens[key] === b.tokens[key]);
}

/** Parse Claude Code JSONL usage after the caller validates its account. */
function parseClaudeRecords(parsed, account) {
  const messages = new Map(), conflicted = new Set();
  let model = null, malformedLines = parsed.malformedLines;
  for (const record of parsed.records) {
    if (record?.type === 'system' && record.subtype === 'init') {
      if (typeof record.model === 'string') model = record.model;
      continue;
    }
    if (record?.type !== 'assistant') continue;
    if (!record.message || typeof record.message !== 'object' || typeof record.message.usage !== 'object' || !record.message.usage) {
      malformedLines++;
      continue;
    }
    const usage = record.message.usage;
    if (!Object.hasOwn(usage, 'input_tokens') || !Object.hasOwn(usage, 'output_tokens')) {
      malformedLines++;
      continue;
    }
    const tokens = claudeTokens(usage);
    const messageModel = typeof record.message.model === 'string' ? record.message.model : model;
    if (!tokens || typeof messageModel !== 'string' || !messageModel) {
      malformedLines++;
      continue;
    }
    const at = timestamp(record.timestamp ?? record.message.timestamp);
    if ((record.timestamp ?? record.message.timestamp) !== undefined && at === null) malformedLines++;
    const id = typeof record.message.id === 'string' && record.message.id.length
      ? record.message.id : JSON.stringify([at, messageModel, tokens]);
    const row = {account, provider:'claude', at, message_id:id, model:messageModel, tokens};
    if (conflicted.has(id)) continue;
    const previous = messages.get(id);
    if (previous && !sameClaudeInputUsage(previous, row)) {
      messages.delete(id);
      conflicted.add(id);
      malformedLines++;
    } else if (!previous) messages.set(id, row);
    else {
      const earliest = previous.at === null ? row.at : row.at === null ? previous.at : Math.min(previous.at, row.at);
      // Equal output selects the last block, while timing belongs to the whole response.
      const selected = row.tokens.output >= previous.tokens.output ? row : previous;
      messages.set(id, {...selected, at:earliest});
    }
  }
  return {usage:[...messages.values()].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)), malformedLines};
}

function parseClaudeSessionLogForAccount(text, account) {
  return parseClaudeRecords(parseJsonLines(text), account);
}

export function parseClaudeRecord(record, {account = 'claude'} = {}) {
  return parseClaudeRecords({records:[record],malformedLines:0}, accountId(account, 'Claude'));
}

/** Parse Claude Code JSONL usage; duplicate content-block copies count once per message ID. */
export function parseClaudeSessionLog(text, {account = 'claude'} = {}) {
  return parseClaudeSessionLogForAccount(text, accountId(account, 'Claude'));
}

function codexCounts(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'input_tokens') || !Object.hasOwn(value, 'output_tokens')) return null;
  const input = count(value.input_tokens), cached = count(value.cached_input_tokens), output = count(value.output_tokens);
  const reasoning = count(value.reasoning_output_tokens);
  if ([input, cached, output, reasoning].some(n => n === null)) return null;
  return {input, cached:Math.min(input, cached), output, reasoning:Math.min(output, reasoning)};
}

function subtractCounts(current, previous) {
  const delta = Object.fromEntries(Object.keys(current).map(key => [key, current[key] - previous[key]]));
  // Totals each keep cached <= input, but their difference need not; such a step cannot be priced.
  if (Object.values(delta).some(value => value < 0) || delta.cached > delta.input || delta.reasoning > delta.output) return null;
  return delta;
}

function toCodexTokens(counts) {
  return {fresh_input:counts.input - counts.cached, cache_read:counts.cached, cache_write_5m:0, cache_write_1h:0,
    output:counts.output, reasoning:counts.reasoning};
}

function allZero(counts) {
  return Object.values(counts).every(value => value === 0);
}

/** Parse Codex rollout JSONL after the caller validates its account. */
function parseCodexRecords(parsed, account, state = {}) {
  const usage = [];
  let model = state.model ?? null, previousTotals = state.previousTotals ?? null, malformedLines = parsed.malformedLines;
  // The session's own identity and signed-in account, from its session_meta line. A copied or resumed file keeps both.
  let session = state.session ?? null, creator = state.creator ?? null;
  const seenWithoutTotals = state.seenWithoutTotals ?? new Set();
  const firstIndex = state.recordIndex ?? 0;
  for (const [index, record] of parsed.records.entries()) {
    const recordIndex = firstIndex + index;
    const payload = record?.payload ?? record;
    const type = payload?.type ?? record?.type;
    if (type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }
    if (type === 'session_meta') {
      const id = payload.id ?? payload.session_id;
      session = typeof id === 'string' && id.length ? accountHash(id) : null;
      creator = typeof payload.creator_account_id === 'string' && payload.creator_account_id.length
        ? accountHash(payload.creator_account_id) : null;
      continue;
    }
    if (type !== 'token_count') continue;
    const info = payload.info;
    const currentModel = typeof payload.model === 'string' ? payload.model : model;
    const at = timestamp(record.timestamp ?? payload.timestamp);
    if (info === null || info === undefined) continue;
    if (typeof info !== 'object') { malformedLines++; continue; }
    const totalPresent = info.total_token_usage !== null && info.total_token_usage !== undefined;
    const lastPresent = info.last_token_usage !== null && info.last_token_usage !== undefined;
    if (!totalPresent && !lastPresent) continue;
    if (typeof currentModel !== 'string' || !currentModel) { malformedLines++; continue; }

    const total = totalPresent ? codexCounts(info.total_token_usage) : null;
    const last = lastPresent ? codexCounts(info.last_token_usage) : null;
    if ((totalPresent && !total) || (lastPresent && !last)) { malformedLines++; continue; }
    const rawMessageId = payload.message_id ?? payload.id ?? record.message_id ?? record.id;
    const explicitMessageId = typeof rawMessageId === 'string' && rawMessageId.length
      ? rawMessageId : typeof rawMessageId === 'number' && Number.isSafeInteger(rawMessageId) ? String(rawMessageId) : null;
    let delta;
    if (totalPresent) {
      delta = previousTotals ? subtractCounts(total, previousTotals) : last ?? total;
      previousTotals = total;
      if (!delta) { malformedLines++; continue; }
      if (allZero(delta)) continue;
    } else {
      if (!last) { malformedLines++; continue; }
      const key = JSON.stringify([explicitMessageId, at, currentModel, last]);
      if (seenWithoutTotals.has(key)) continue;
      seenWithoutTotals.add(key);
      delta = last;
    }
    if (at === null && (record.timestamp ?? payload.timestamp) !== undefined) malformedLines++;
    // An event without its own id is named by its session and the session's running totals, which no other event in that
    // session repeats and every copy of the file keeps. With no session id it stays a per-file record, never measured.
    const message_id = explicitMessageId ?? (session
      ? `codex-session-${session}-${JSON.stringify(total ?? [at, last])}` : `codex-record-${recordIndex}`);
    // Rate limits come back only on a plan sign-in. An event without them may have been paid by API key. Only the bucket
    // the lent meter reads counts: a limit_id of 'codex' or none (see codexWindows); another bucket is a different meter.
    const rateLimits = payload.rate_limits;
    const mainBucket = rateLimits?.limit_id === undefined || rateLimits.limit_id === null || rateLimits.limit_id === 'codex';
    const funding = rateLimits && typeof rateLimits === 'object' && Object.keys(rateLimits).length && mainBucket
      ? 'subscription' : 'unknown';
    usage.push({account, provider:'codex', at, message_id, model:currentModel, tokens:toCodexTokens(delta), funding,
      creator_account_sha256_16:creator});
  }
  Object.assign(state, {model,previousTotals,seenWithoutTotals,session,creator,recordIndex:firstIndex + parsed.records.length});
  return {usage:usage.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)), malformedLines};
}

function parseCodexRolloutLogForAccount(text, account) {
  return parseCodexRecords(parseJsonLines(text), account);
}

export function parseCodexRecordsForWorker(records, {account = 'codex', state = {}} = {}) {
  return parseCodexRecords({records,malformedLines:0}, accountId(account, 'Codex'), state);
}

/** Parse Codex rollout JSONL. Cumulative token snapshots are differenced, so repeats do not double count. */
export function parseCodexRolloutLog(text, {account = 'codex'} = {}) {
  return parseCodexRolloutLogForAccount(text, accountId(account, 'Codex'));
}

function pointsForUsage(row, upperMicro) {
  const prompt = row.tokens.fresh_input + row.tokens.cache_read + row.tokens.cache_write_5m + row.tokens.cache_write_1h;
  const priced = priceListUsd(row.model, row.tokens, {calls:[{...row.tokens, prompt}]});
  if (!priced.priced || !Number.isFinite(priced.usd)) return null;
  if (!Number.isSafeInteger(upperMicro) || upperMicro <= 0) return null;
  const usdMicro = Math.ceil(priced.usd * 1e6);
  if (!Number.isSafeInteger(usdMicro) || usdMicro < 0) return null;
  const pointsMicro = (BigInt(usdMicro) * BigInt(upperMicro) + 999_999n) / 1_000_000n;
  return pointsMicro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pointsMicro) / 1e6 : null;
}

function periodTime(value, name) {
  const parsed = timestamp(value);
  if (parsed === null) throw new TypeError(`meter period ${name} is invalid`);
  return parsed;
}

function validateMinimumCoverage(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new TypeError('minimumCoverage must be greater than 0 and at most 1');
}

function windowForResource(resource) {
  const [account, ...parts] = resource.split(':');
  let suffix = parts.join(':').toLowerCase();
  if (suffix.startsWith(`${account}:`)) suffix = suffix.slice(account.length + 1);
  // The guard's bucketed ID is codex:<limit_id>:<canonical minutes>; persisted
  // resources may prepend codex: once more. Classify duration without dropping
  // the bucket from the resource used by the accounting/calibration maps.
  if (account === 'codex' && /^[^:]+:\d+(?:\.\d+)?$/.test(suffix)) suffix = suffix.slice(suffix.lastIndexOf(':') + 1);
  if (suffix === 'five_hour' || suffix === '5h' || suffix === '300') return 'five_hour';
  if (suffix === 'weekly' || suffix === 'seven_day' || suffix === '10080') return 'weekly';
  return null;
}

function conversionMicro(kappaForUsage, period, row) {
  if (typeof kappaForUsage !== 'function') return null;
  const window = windowForResource(period.resource);
  if (!window) return null;
  let calibration;
  try {
    calibration = kappaForUsage({account:period.account, provider:providerFor(period.resource), resource:period.resource,
      window, model:row.model});
  } catch { return null; }
  const provenance = calibration?.provenance;
  return Number.isSafeInteger(calibration?.upper_micro) && calibration.upper_micro > 0 &&
    typeof provenance?.method === 'string' && provenance.method.length > 0 &&
    ((provenance.label === MEASURED_LABEL) ||
    (typeof provenance?.boundReport === 'string' && provenance.boundReport.length > 0 &&
    typeof provenance?.acceptedBy === 'string' && provenance.acceptedBy.length > 0))
    ? calibration.upper_micro : null;
}

function providerFor(resource) {
  if (typeof resource !== 'string') return null;
  const separator = resource.indexOf(':');
  if (separator <= 0 || separator === resource.length - 1) return null;
  const provider = resource.slice(0, separator);
  return provider === 'claude' || provider === 'codex' ? provider : null;
}

function resourceWindowMs(resource) {
  const [account, ...parts] = resource.split(':');
  let suffix = parts.join(':').toLowerCase();
  if (suffix.startsWith(`${account}:`)) suffix = suffix.slice(account.length + 1);
  // The guard's bucketed ID is codex:<limit_id>:<canonical minutes>; persisted
  // resources may prepend codex: once more. Classify duration without dropping
  // the bucket from the resource used by the accounting/calibration maps.
  if (account === 'codex' && /^[^:]+:\d+(?:\.\d+)?$/.test(suffix)) suffix = suffix.slice(suffix.lastIndexOf(':') + 1);
  if (suffix === 'five_hour' || suffix === '5h' || suffix === '300') return 5 * HOUR_MS;
  if (suffix === 'weekly' || suffix === 'seven_day' || suffix === '10080') return WEEK_MS;
  const minutes = /^\d+$/.test(suffix) ? Number(suffix) : null;
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes < WEEK_MS / 60_000 ? minutes * 60_000 : null;
}

/** Score complete reset-bounded periods. Missing or weak coverage is +Infinity, never a light week. */
export function buildImportedWeeklyScores({usage = [], meterPeriods = [], kappaForUsage = null,
  minimumCoverage = DEFAULT_MINIMUM_COVERAGE, untrusted = [], currentWindows = [], incomplete = false,
  droppedItems = []} = {}) {
  validateMinimumCoverage(minimumCoverage);
  // ASSUMPTION: the share of account usage on other devices stays stable across weeks.
  // Current-window coverage is a bootstrap calibration, NOT completed meter evidence.
  const calibrations = new Map();
  const periods = [...meterPeriods];
  for (const window of currentWindows) {
    if (meterPeriods.some(period => period.account === window.account && Number.isFinite(period.meter_points))) continue;
    const start = timestamp(window.start_at), observed = timestamp(window.observed_at);
    const end = timestamp(window.end_at), epoch = timestamp(window.account_week_id);
    if (start === null || observed === null || end === null || epoch === null ||
        start > observed || observed >= end || observed >= epoch || !(window.meter_points > 0)) continue;
    const probe = buildImportedWeeklyScores({usage, kappaForUsage, minimumCoverage, untrusted, incomplete, droppedItems,
      meterPeriods:[{...window, start_at:start, end_at:observed+1, week_start:start, account_week_id:observed+1}]});
    const ratio = probe.coverage[0]?.coverage_ratio ?? null;
    calibrations.set(window.resource, {ratio, window:{start_at:start, end_at:end, observed_at:observed,
      meter_points:window.meter_points}});
    const relevant = usage.filter(row => row.account === window.account && row.provider === providerFor(window.resource) && row.at !== null);
    const earliest = relevant.length ? relevant.reduce((earliest,row)=>Math.min(earliest,row.at), Infinity) : Infinity;
    for (let weekEnd = epoch-WEEK_MS, n = 0; n < 26 && weekEnd > earliest; weekEnd -= WEEK_MS, n++) {
      if (!periods.some(period => period.resource === window.resource && Math.abs(period.account_week_id-weekEnd) <= 60_000))
        periods.push({account:window.account, resource:window.resource, account_week_id:weekEnd,
          week_start:weekEnd-WEEK_MS, start_at:weekEnd-WEEK_MS, end_at:weekEnd, meter_points:null});
    }
  }
  const weeklyScores = [], coverage = [], usageSamples = [], seenPeriods = new Set();
  for (const period of periods) {
    const start = periodTime(period.start_at, 'start_at'), end = periodTime(period.end_at, 'end_at');
    const week_start = periodTime(period.week_start, 'week_start');
    const provider = providerFor(period.resource);
    const meterUnknown = period.meter_points === null || period.meter_points === undefined || period.meter_points === Infinity;
    if (!(end > start) || Math.abs(period.account_week_id - end) > 60_000 || Math.abs(week_start - start) > 60_000 ||
      (meterUnknown ? period.meter_points === -Infinity : !Number.isFinite(period.meter_points) || period.meter_points < 0) ||
      typeof period.account !== 'string' || typeof period.resource !== 'string' || !/^[a-z0-9_:.-]{1,60}$/.test(period.resource) ||
      !Number.isSafeInteger(period.account_week_id) || period.account_week_id < 0 || !['claude', 'codex'].includes(provider))
      throw new TypeError('meter period is invalid');
    accountId(period.account, provider);
    const periodKey = `${period.resource}\0${period.account_week_id}`;
    if (seenPeriods.has(periodKey)) throw new TypeError('meter periods must contain one complete interval per resource and account week');
    seenPeriods.add(periodKey);
    const relevant = usage.filter(row => row.account === period.account && row.provider === provider);
    const itemAffectsPeriod = item => {
      if (!item || !['claude','codex'].includes(item.provider) || typeof item.account !== 'string' ||
          !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.account)) return true;
      return item.account === period.account && item.provider === provider;
    };
    const periodIncomplete = incomplete || droppedItems.some(itemAffectsPeriod) || untrusted.some(itemAffectsPeriod);
    const untrustedPeriod = periodIncomplete ||
      relevant.some(row => row.at === null);
    const pricedUsage = [];
    let unpriced = false;
    for (const row of relevant) {
      if (row.at === null || row.at < start || row.at >= end) continue;
      const upperMicro = conversionMicro(kappaForUsage, period, row);
      const points = upperMicro === null ? null : pointsForUsage(row, upperMicro);
      if (points === null) unpriced = true;
      else pricedUsage.push({at:row.at, points, session_id:row.session_id, message_id:row.message_id, model:row.model});
    }
    const windowMs = resourceWindowMs(period.resource);
    let logPoints;
    if (windowMs === null) logPoints = pricedUsage.reduce((sum, row) => sum + row.points, 0);
    else {
      const orderedUsage = [...pricedUsage].sort((a,b) => a.at-b.at);
      logPoints = 0;
      let startIndex = 0, rolling = 0;
      for (let endIndex = 0; endIndex < orderedUsage.length; endIndex++) {
        const endUsage = orderedUsage[endIndex];
        rolling += endUsage.points;
        while (orderedUsage[startIndex].at < endUsage.at-windowMs) rolling -= orderedUsage[startIndex++].points;
        logPoints = Math.max(logPoints, rolling);
      }
    }
    if (!Number.isFinite(logPoints)) unpriced = true;
    const calibration = meterUnknown ? calibrations.get(period.resource) : null;
    const ratio = calibration && !untrustedPeriod && !unpriced && pricedUsage.length > 0 ? calibration.ratio : !untrustedPeriod && !unpriced && !meterUnknown && period.meter_points > 0
      ? Math.min(1, logPoints / period.meter_points) : null;
    const scoreCandidate = ratio === null || ratio < minimumCoverage ? Infinity : logPoints / minimumCoverage;
    const censored = !Number.isFinite(scoreCandidate) || scoreCandidate > 100;
    const score = censored ? Infinity : Math.ceil(scoreCandidate * 1e6) / 1e6;
    const row = {resource:period.resource, account_week_id:period.account_week_id,
      week_start, score, censored, source:calibration ? 'import-open-window' : 'import', coverage_ratio:ratio,
      ...(periodIncomplete ? {incomplete:true} : {}),
      ...(calibration ? {calibration_window:calibration.window} : {})};
    weeklyScores.push(row);
    if (!censored && ratio !== null) for (const sample of pricedUsage) {
      if (typeof sample.session_id !== 'string' || !sample.session_id || typeof sample.model !== 'string' || !sample.model) continue;
      usageSamples.push({resource:row.resource, account_week_id:row.account_week_id, week_start:row.week_start,
        session_id:sample.session_id, message_id:sample.message_id, at:sample.at, points:sample.points, model:sample.model});
    }
    coverage.push({account:period.account, resource:period.resource, account_week_id:row.account_week_id, week_start, coverage_ratio:ratio,
      log_points:logPoints, meter_points:period.meter_points, minimum_coverage:minimumCoverage});
  }
  return {weeklyScores, coverage, usageSamples};
}

/** The only import-to-history mapping. The history store can change without altering parsing or scoring. */
export function adaptImportedScoresToHistory(rows = []) {
  return rows.map(row => {
    const account = providerFor(row.resource);
    if (!account) throw new TypeError('imported score resource must name its provider account');
    return {account, resource:row.resource.slice(account.length + 1), account_week_id:row.account_week_id,
      week_start:row.week_start, score:row.censored ? Infinity : row.score, censored:row.censored === true,
      source:row.source === 'import-open-window' ? row.source : 'import', coverage_ratio:row.coverage_ratio,
      ...(row.incomplete === true ? {incomplete:true} : {}),
      ...(row.calibration_window ? {calibration_window:row.calibration_window} : {})};
  });
}

/** Adapter from the importer contract to the persisted account-scoped lending-history store. */
export function createLocalLendingHistoryAdapter({homeDir, now = Date.now, ledger:providedLedger} = {}) {
  if (typeof homeDir !== 'string' || !isAbsolute(homeDir)) throw new TypeError('homeDir must be absolute');
  const ledger = providedLedger ?? createLendingLedger({file:join(homeDir, 'v1', 'lending-ledger.json'), now});
  const histories = Object.fromEntries(['claude', 'codex'].map(account => [account,
    createLendingHistory({home:homeDir, account, ledger, now})]));
  const meterPeriods = [], existingScores = [], currentWindows = [], kappaPeriods = [];
  for (const history of Object.values(histories)) {
    currentWindows.push(...history.currentWindows());
    kappaPeriods.push(...history.meterSpans());
  }
  for (const account of Object.keys(histories)) {
    const history = histories[account];
    for (const resource of history.resources()) {
      for (const row of history.weeklyScores(resource).values()) {
        const accountResource = `${account}:${resource}`;
        const hasMeterRecord = row.sampleCount > 0 || row.source === 'meter' || row.source.startsWith('meter+');
        meterPeriods.push({account, resource:accountResource, account_week_id:row.epoch, week_start:row.start,
          start_at:row.start, end_at:row.end,
          meter_points:hasMeterRecord && row.complete && Number.isFinite(row.score) ? row.score : null});
        if (hasMeterRecord || isImport(row.source) || row.source === 'session_log_bootstrap') {
          existingScores.push({resource:accountResource, account_week_id:row.epoch, week_start:row.start,
            score:row.score, censored:!row.complete, source:hasMeterRecord ? 'meter' : row.source === 'import-open-window' ? row.source : 'import',
            coverage_ratio:row.coverage_ratio ?? null});
        }
      }
    }
  }
  return {meterPeriods, kappaPeriods, existingScores, currentWindows, deleteImportedHistory() {
    clearParsedLogCache();
    for (const history of Object.values(histories)) history.deleteImportedHistory();
  }, writeImportedScores(rows, usageSamples = [], usageSampleWeeks = rows) {
    const mapped = adaptImportedScoresToHistory(rows);
    const mappedSamples = usageSamples.map(sample => {
      const account = providerFor(sample.resource);
      if (!account) throw new TypeError('imported usage sample resource must name its provider account');
      return {...sample, account, resource:sample.resource.slice(account.length + 1)};
    });
    const mappedWeeks = usageSampleWeeks.map(row => {
      const account = providerFor(row.resource);
      if (!account) throw new TypeError('imported usage sample week must name its provider account');
      return {...row, account, resource:row.resource.slice(account.length + 1)};
    });
    for (const account of Object.keys(histories)) {
      const accountRows = mapped.filter(row => row.account === account).map(({account:_account, ...row}) => row);
      const accountSamples = mappedSamples.filter(sample => sample.account === account)
        .map(({account:_account, ...sample}) => sample);
      const accountSampleWeeks = mappedWeeks.filter(row => row.account === account)
        .map(({account:_account, ...row}) => row);
      if (accountRows.length || accountSamples.length || accountSampleWeeks.length) histories[account].bootstrapFromSessionLogs({
        readWeeklyUsage:() => accountRows, readUsageSamples:() => accountSamples,
        readUsageSampleWeeks:() => accountSampleWeeks,
      });
    }
  }};
}

function scoreKey(row) {
  return `${row.resource}\0${row.account_week_id}`;
}

/** Meter-derived rows are authoritative. A later explicit import can replace only an earlier import row. */
export function mergeWeeklyScores(existing = [], imported = []) {
  const rows = new Map();
  for (const row of existing) {
    const key = scoreKey(row), previous = rows.get(key);
    if (!previous || isImport(previous.source) && !isImport(row.source) || isImport(row.source) && isImport(previous.source))
      rows.set(key, row);
  }
  for (const row of imported) {
    const key = scoreKey(row), previous = rows.get(key);
    if (!previous) rows.set(key, {...row, source:row.source === 'import-open-window' ? row.source : 'import'});
    else if (isImport(previous.source)) rows.set(key, {...row, source:row.source === 'import-open-window' ? row.source : 'import'});
  }
  return [...rows.values()];
}

/** Explicitly invoked local import. The loader is never called until owner consent is true. */
export function importLendingHistory({consent, loadSessionLogs, meterPeriods = [], existingScores = [],
  kappaForUsage = null, minimumCoverage = DEFAULT_MINIMUM_COVERAGE, currentWindows = [], incomplete = false,
  droppedItems = [], onKappa = null, kappaPeriods = meterPeriods, logAttribution = null, now = Date.now()} = {}) {
  if (consent !== true) throw historyError('consent_required', 'Owner consent is required to import local session history.');
  validateMinimumCoverage(minimumCoverage);
  if (typeof loadSessionLogs !== 'function') throw new TypeError('loadSessionLogs must be a function');
  const logs = loadSessionLogs();
  if (!logs || typeof logs[Symbol.iterator] !== 'function') throw new TypeError('loadSessionLogs must return session logs');
  const periods = [...meterPeriods];
  const usage = [], measureUsage = [], measuredIds = new Set(), untrusted = [], sessions = [];
  let malformedLines = 0;
  for (const log of logs) {
    const provider = log?.provider;
    if (!['claude', 'codex'].includes(provider)) throw new TypeError('session log provider is invalid');
    const account = accountId(log?.account ?? provider, provider === 'claude' ? 'Claude' : 'Codex');
    const parsed = log[parsedLog] ?? log.parsed ?? (provider === 'claude'
      ? parseClaudeSessionLogForAccount(log.contents, account)
      : parseCodexRolloutLogForAccount(log.contents, account));
    const session_id = importedSessionId(provider, log.source, log.contents, parsed.usage);
    // The folder a log came from names its account. A folder read only to measure the lent account stays out of scoring.
    const root = logAttribution?.roots?.find(r => r.provider === provider && typeof log.source === 'string' &&
      log.source.startsWith(r.path + sep));
    const attributed_account = root?.since != null ? root.account_sha256_16 : null;
    // Claude logs name no payer per message: a Claude row is plan use only by its folder, which is attributed only while it is
    // signed in to the lent account with no API key in its settings files. A Codex row carries its own evidence from the parser.
    const rows = parsed.usage.map(row => ({...row, session_id, attributed_account,
      ...(provider === 'claude' ? {funding:attributed_account ? 'subscription' : 'unknown'} : {})}));
    // A resumed, forked or copied session repeats earlier messages in another file. Price each provider message once; a
    // message with no identity that survives a copy is never measured.
    for (const row of rows) {
      // Only rows that can count take part, so a copy in a folder that cannot count never hides the one that can.
      if (!row.attributed_account || row.funding !== 'subscription' || typeof row.message_id !== 'string' || !row.message_id ||
          row.message_id.startsWith('codex-record-')) continue;
      const key = `${provider}/${row.message_id}`;
      if (measuredIds.has(key)) continue;
      measuredIds.add(key);
      measureUsage.push(row);
    }
    if (root?.scoring === false) continue;
    usage.push(...rows);
    if (parsed.usage.length) sessions.push({account, provider, session_id});
    malformedLines += parsed.malformedLines;
    if (parsed.malformedLines > 0) untrusted.push({account, provider, mtimeMs:log.mtimeMs});
  }
  if (typeof onKappa === 'function') {
    const scopes = new Map([...kappaPeriods, ...currentWindows].map(p => [`${p.account}/${p.resource}`, p]));
    for (const {account, resource} of scopes.values()) {
      const previous = kappaForUsage?.({account, resource, provider:providerFor(resource), window:windowForResource(resource),
        model:usage.find(row=>row.account===account)?.model, measuredOnly:true});
      const attribution = logAttribution?.providers?.[providerFor(resource)] ?? null;
      const estimate = measureKappa({account, resource, usage:measureUsage, previous, attribution,
        meterPeriods:kappaPeriods, currentWindows, now});
      // Codex plan use is on record, yet no event names the account it was signed in to: an older CLI that Faravan cannot
      // measure until it is updated. Using the account more does not help.
      const codexRows = measureUsage.filter(row => row.provider === 'codex' && row.account === account);
      const reason = !estimate && providerFor(resource) === 'codex' && codexRows.length > 0 &&
        codexRows.every(row => row.creator_account_sha256_16 == null) ? 'creator_unknown' : null;
      onKappa({account, resource, estimate, reason});
    }
  }
  const scored = buildImportedWeeklyScores({usage, meterPeriods:periods, kappaForUsage, minimumCoverage, untrusted, currentWindows,
    incomplete, droppedItems});
  const weeklyScores = mergeWeeklyScores(existingScores, scored.weeklyScores);
  const importedWeeklyScores = scored.weeklyScores.filter(row => {
    return !existingScores.some(existing => scoreKey(existing) === scoreKey(row) && !isImport(existing.source));
  });
  const scoredKeys = new Set(scored.weeklyScores.map(scoreKey));
  const coverageByWeek = new Map(scored.coverage.map(row => [scoreKey(row), row.coverage_ratio]));
  const usageSamples = scored.usageSamples.filter(sample => scoredKeys.has(scoreKey(sample)))
    .map(sample => ({...sample, coverage_ratio:coverageByWeek.get(scoreKey(sample)) ?? null}));
  const usageSampleWeeks = scored.weeklyScores.map(({resource, account_week_id, week_start}) =>
    ({resource, account_week_id, week_start}));
  const anchoredSessions = new Set();
  for (const period of periods) {
    const provider = providerFor(period.resource);
    const start = periodTime(period.start_at, 'start_at'), end = periodTime(period.end_at, 'end_at');
    for (const row of usage) if (row.account === period.account && row.provider === provider &&
      row.at !== null && row.at >= start && row.at < end) anchoredSessions.add(row.session_id);
  }
  const unmapped_sessions = sessions.filter(session => !anchoredSessions.has(session.session_id)).length;
  return {weeklyScores, importedWeeklyScores, usageSamples, usageSampleWeeks, coverage:scored.coverage,
    malformedLines, unmapped_sessions};
}

/** Opt-in ops bridge. The history adapter supplies every reset interval (null meter points when unobserved), existing
 * scores and a local-only writer; omitting an interval would omit that unknown week instead of recording +Infinity. */
export async function importOwnerLendingHistory({consent, homeDir, sessionHomeDir = homedir(),
  kappaForUsage, minimumCoverage = DEFAULT_MINIMUM_COVERAGE, historyAdapter, shouldContinue = () => true, onProgress, onKappa = null,
  logAttribution = null, now = Date.now} = {}) {
  if (consent !== true) throw historyError('consent_required', 'Owner consent is required to import local session history.');
  validateMinimumCoverage(minimumCoverage);
  if (!canContinue(shouldContinue) || !localHistoryLearningEnabled(homeDir)) return {skipped:true};
  const adapter = historyAdapter ?? createLocalLendingHistoryAdapter;
  const history = await adapter({homeDir, sessionHomeDir, now});
  if (!history || !Array.isArray(history.meterPeriods) || !Array.isArray(history.existingScores) ||
    typeof history.writeImportedScores !== 'function')
    throw historyError('history_store_unavailable', 'The local weekly history adapter is incomplete.');
  if (!canContinue(shouldContinue) || !localHistoryLearningEnabled(homeDir)) return {skipped:true};
  // Attribution names the folders to read: the default folders for scoring, plus any folder signed in to the lent account.
  const attribution = typeof logAttribution === 'function' ? logAttribution(sessionHomeDir) : logAttribution;
  const loaded = await readLocalAgentSessionLogsInWorker(sessionHomeDir,{logRoots:attribution?.roots ?? null,meterPeriods:history.meterPeriods,currentWindows:history.currentWindows ?? [],shouldContinue,onProgress});
  if (loaded.aborted || !canContinue(shouldContinue) || !localHistoryLearningEnabled(homeDir)) return {skipped:true};
  const result = importLendingHistory({consent:true, loadSessionLogs:() => loaded.logs,
    meterPeriods:history.meterPeriods, existingScores:history.existingScores, currentWindows:history.currentWindows ?? [], kappaForUsage, minimumCoverage,
    incomplete:Boolean(loaded.errorCode), droppedItems:loaded.droppedItems ?? [], onKappa, kappaPeriods:history.kappaPeriods ?? history.meterPeriods, logAttribution:attribution, now:now()});
  if (!canContinue(shouldContinue) || !localHistoryLearningEnabled(homeDir)) return {skipped:true};
  await history.writeImportedScores(result.importedWeeklyScores, result.usageSamples, result.usageSampleWeeks);
  return {imported_weeks:result.importedWeeklyScores.length,
    censored_weeks:result.importedWeeklyScores.filter(row => row.censored).length,
    usage_samples:result.usageSamples.length,
    malformed_lines:result.malformedLines,
    incomplete:loaded.incomplete,
    ...(loaded.errorCode ? {error_code:loaded.errorCode} : {}),
    ...(loaded.errorMessage ? {error_message:loaded.errorMessage} : {}),
    skipped_files:loaded.skippedFiles,
    skipped_bytes:loaded.skippedBytes,
    skipped_lines:loaded.skippedLines,
    skipped_rows:loaded.skippedRows,
    skipped_file_paths:loaded.skippedFilePaths,
    dropped_items:loaded.droppedItems ?? [],
    unmapped_sessions:result.unmapped_sessions,
    coverage:result.coverage.map(({resource, account_week_id, week_start, coverage_ratio}) =>
      ({resource, account_week_id, week_start, coverage_ratio}))};
}

/** The same durable owner switch also governs standalone/manual operations. */
export function localHistoryLearningEnabled(homeDir) {
  if (typeof homeDir !== 'string' || !isAbsolute(homeDir)) throw new TypeError('homeDir must be absolute');
  let text;
  try { text = readFileSync(join(homeDir, 'v1', 'app-settings.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      settings.learnFromLocalAgentLogs !== undefined && typeof settings.learnFromLocalAgentLogs !== 'boolean')
    throw historyError('invalid_history_learning_setting', 'Local history learning setting is unreadable.');
  return settings.learnFromLocalAgentLogs !== false;
}
