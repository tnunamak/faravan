// The outbox: every serialized byte that will leave, or did leave, this computer, within fixed bounds. It is also the data
// source of the "See what we send" view. Design §2.2.
//
//   <dir>/outbox/<lane>-<seq>.jsonl   one record per line:  <gen> TAB <notBefore> TAB <appendedAt> TAB <canonical record JSON>
//   <dir>/outbox/cursor.json          {next, lanes:{<lane>:{seq, offset}}, halt}      (atomic; only moves forward)
//   <dir>/outbox/inflight-<stream>.json   the batch being sent for one stream, with its generation, so a retry after a crash reuses its
//                                     batch_id (the server dedupes on it) and never outlives its consent
//   <dir>/outbox/rewrite.json         a lane rewrite in progress; startup finishes or rolls it back, so a crash never doubles a record
//   <dir>/sent/<batchId>.json         the exact request body; <batchId>.meta.json holds {at, outcome, status, bytes}
//
// A lane holds one stream, one delivery class and one uploading service: records in a lane leave in order, and a record's
// random delay (notBefore) can hold back only its own lane. Records leave only under the generation they were captured in.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveJsonFile } from '../../local-state.mjs';
import { ensureDurableDirectory } from '../../durable-directory.mjs';
import { CATALOG, ORIGIN_SERVICE } from './catalog.mjs';
import { parseQueuedRecord, stampRecord } from './posthog.mjs';
import { randomId } from './ids.mjs';

export const OUTBOX_LIMITS = Object.freeze({totalBytes: 10 * 1024 * 1024, ageMs: 7 * 86400000, segmentBytes: 256 * 1024, sentBytes: 2 * 1024 * 1024});
// Eviction order when the outbox is full: counts are small and the most valuable (design §2.2).
const EVICTION_ORDER = ['diagnostics', 'quota', 'counts'];
const SEGMENT = /^([a-z]+(?:\.[a-z]+)*)-(\d+)\.jsonl$/;

/** The lane of a validated record: its stream, its delivery class (counts only) and the service that uploads it. */
export function laneOf(record) {
  const entry = CATALOG.entries[record.name] ?? {stream:'diagnostics'};
  const cls = entry.stream === 'counts' ? '.' + entry.period : '';
  return entry.stream + cls + '.' + ORIGIN_SERVICE[record.origin ?? 'app'];
}
const streamOf = lane => lane.split('.')[0];
const serviceOf = lane => lane.split('.').at(-1);

const isRecordJson = json => { try { return JSON.parse(json)?.name !== undefined; } catch { return false; } };

function parseLines(text, from = 0) {
  const lines = [];
  let start = from;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end < 0) break; // a torn tail after a crash: skipped, and terminated before the next append
    const row = text.slice(start, end).split('\t');
    const [gen, notBefore, at] = [Number(row[0]), Number(row[1]), Number(row[2])];
    const json = row.slice(3).join('\t');
    if (row.length >= 4 && Number.isInteger(gen) && Number.isFinite(notBefore) && Number.isFinite(at) && isRecordJson(json)) lines.push({start, end: end + 1, gen, notBefore, at, json});
    else lines.push({start, end: end + 1, bad: true});
    start = end + 1;
  }
  return lines;
}

/** `onDrop(reason, count, entryName)` reports every record that is discarded, so the facade can count `telemetry.self`. */
export function createOutbox({dir, base, now = Date.now, bytes, onDrop = () => {}}) {
  const root = join(dir, 'outbox'), sentDir = join(dir, 'sent');
  const cursorFile = join(root, 'cursor.json'), journalFile = join(root, 'rewrite.json');
  const inflightFile = stream => join(root, `inflight-${stream}.json`);
  const clearInflight = () => { for (const name of readdirSync(root)) if (/^inflight-[a-z]+\.json$/.test(name)) rmSync(join(root, name), {force: true}); };
  ensureDurableDirectory(root, {base});
  ensureDurableDirectory(sentDir, {base});

  let cursor = {next: 1, lanes: {}, halt: null};
  try {
    const raw = JSON.parse(readFileSync(cursorFile, 'utf8'));
    if (raw && Number.isSafeInteger(raw.next) && raw.lanes && typeof raw.lanes === 'object') cursor = {next: raw.next, lanes: raw.lanes, halt: raw.halt ?? null};
  } catch { /* first start, or a torn cursor: every segment is read from its start, and the server dedupes */ }
  const saveCursor = () => saveJsonFile(cursorFile, cursor, {base});

  const segmentPath = (lane, seq) => join(root, `${lane}-${seq}.jsonl`);
  function segments() {
    const out = [];
    for (const name of readdirSync(root)) {
      const match = SEGMENT.exec(name);
      if (match) out.push({lane: match[1], seq: Number(match[2]), file: join(root, name)});
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
  const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  // Write and flush a file, and flush the directory entry, so a power cut cannot leave a half-committed rewrite.
  function syncDir() {
    let fd;
    try { fd = openSync(root, 'r'); fsyncSync(fd); } catch { /* a platform that cannot flush a directory */ } finally { if (fd !== undefined) closeSync(fd); }
  }
  function writeDurable(file, text) {
    const fd = openSync(file, 'w', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  }
  // Anything below a lane's cursor is garbage (an interrupted rewrite or ack): clean it up on every start.
  function sweep() {
    // A rewrite that was interrupted: if the cursor reached the new segment the rewrite committed and the old segments
    // are garbage (the rule below); if not, the new segment is not part of the queue and goes.
    let journal;
    try { journal = JSON.parse(readFileSync(journalFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal) {
      if (cursor.lanes[journal.lane]?.seq !== journal.seq) rmSync(segmentPath(journal.lane, journal.seq), {force: true});
      // Committed: the batch in flight moves onto the rewritten lane together with the cursor.
      else if (journal.survivor) saveJsonFile(inflightFile(streamOf(journal.lane)), journal.survivor, {base});
      else if (journal.clearInflight) rmSync(inflightFile(streamOf(journal.lane)), {force: true});
    }
    rmSync(journalFile, {force: true});
    for (const name of readdirSync(root)) if (name.endsWith('.jsonl.tmp')) rmSync(join(root, name), {force: true}); // a replacement that never committed
    for (const segment of segments()) {
      const at = cursor.lanes[segment.lane];
      if (at && segment.seq < at.seq) rmSync(segment.file, {force: true});
    }
  }
  sweep();

  const positionOf = lane => cursor.lanes[lane] ?? {seq: 0, offset: 0};
  /** Unconsumed lines of a lane, in order, with their segment and absolute offsets. */
  function pending(lane) {
    const at = positionOf(lane);
    const out = [];
    for (const segment of segments().filter(s => s.lane === lane && s.seq >= at.seq)) {
      const text = readText(segment.file);
      for (const line of parseLines(text, segment.seq === at.seq ? at.offset : 0)) out.push({...line, seq: segment.seq, size: text.length});
    }
    return out;
  }
  const lanes = () => [...new Set(segments().map(s => s.lane))];
  const nameOf = json => { try { return JSON.parse(json).name; } catch { return 'none'; } };
  const tally = (reason, lines) => {
    const byName = new Map();
    for (const line of lines) { const name = line.bad ? 'none' : nameOf(line.json); byName.set(name, (byName.get(name) ?? 0) + 1); }
    return [...byName].map(([name, n]) => ({reason, name, n}));
  };
  const report = drops => { for (const {reason, name, n} of drops) onDrop(reason, n, name); };
  const drop = (reason, lines) => report(tally(reason, lines));

  // A crash can leave half a line at the end. Cut it off before appending, so it cannot become the start of a new line.
  function dropTornTail(file) {
    const data = readFileSync(file);
    if (data.length && data.at(-1) !== 10) truncateSync(file, data.lastIndexOf(10) + 1);
  }
  let open = new Map(); // lane -> {seq, size}: the segment appends go to
  function openSegment(lane) {
    let segment = open.get(lane);
    if (segment && existsSync(segmentPath(lane, segment.seq)) && segment.size < OUTBOX_LIMITS.segmentBytes) return segment;
    const existing = segments().filter(s => s.lane === lane).at(-1);
    if (existing) dropTornTail(existing.file);
    const size = existing ? statSync(existing.file).size : Infinity;
    if (existing && size < OUTBOX_LIMITS.segmentBytes) segment = {seq: existing.seq, size};
    else { segment = {seq: cursor.next++, size: 0}; saveCursor(); }
    open.set(lane, segment);
    return segment;
  }

  // A live batch points past the end of its segment only when the segment has lost its tail under it. Its end is where the
  // cursor will move once the batch settles, so an append into those bytes would be skipped.
  function batchPastEnd(lane, seq, file) {
    const span = outbox.inflight(streamOf(lane))?.lanes?.[lane];
    return span !== undefined && span.seq === seq && span.to > (existsSync(file) ? statSync(file).size : 0);
  }

  /** Append the lines for one lane in a single write and one fsync. */
  function appendLines(lane, lines) {
    let segment = openSegment(lane), file = segmentPath(lane, segment.seq);
    if (batchPastEnd(lane, segment.seq, file)) {
      segment = {seq: cursor.next++, size: 0};
      saveCursor();
      open.set(lane, segment);
      file = segmentPath(lane, segment.seq);
    }
    const text = lines.map(({gen, notBefore, at, json}) => `${gen}\t${notBefore}\t${at}\t${json}\n`).join('');
    const fd = openSync(file, 'a', 0o600);
    try {
      appendFileSync(fd, text);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    segment.size += Buffer.byteLength(text);
    return Buffer.byteLength(text);
  }

  const totalBytes = () => segments().reduce((sum, s) => sum + statSync(s.file).size, 0);
  // A running estimate, so an append does not rescan the outbox; the full bounds check runs when it passes the limit and hourly.
  let estimate = totalBytes();

  /**
   * Rewrite a lane's unconsumed lines into one fresh segment and move the cursor onto it. `remap(line)` returns the
   * generation a line keeps, or null to drop it. The old segments go last, so a crash leaves a state `sweep` repairs.
   */
  function rewrite(lane, remap, {survivorGen, dropNames} = {}) {
    const kept = [], dropped = [];
    for (const line of pending(lane)) {
      const gen = line.bad ? null : remap(line);
      if (gen === null) dropped.push(line); else kept.push({...line, gen});
    }
    const old = segments().filter(s => s.lane === lane);
    const seq = cursor.next++;
    // What the batch in flight (if any) holds from this lane must survive the rewrite as its first lines, or the batch goes.
    const flying = outbox.inflight(streamOf(lane));
    let survivor = null, clearFlying = false;
    if (flying?.lanes?.[lane]) {
      const names = Object.keys(flying.lanes);
      const from = names.slice(0, names.indexOf(lane)).reduce((sum, name) => sum + (flying.lanes[name].n ?? 0), 0), n = flying.lanes[lane].n ?? 0;
      const mine = flying.records.slice(from, from + n);
      const retained = dropNames ? mine.filter(json => !dropNames.includes(nameOf(json))) : mine;
      if (n > 0 && kept.length >= retained.length && retained.every((json, i) => kept[i].json === json)) {
        const batchLanes = {...flying.lanes};
        if (retained.length) batchLanes[lane] = {...batchLanes[lane], n: retained.length, seq, from: 0,
          to: Buffer.byteLength(kept.slice(0, retained.length).map(line => `${line.gen}\t${line.notBefore}\t${line.at}\t${line.json}\n`).join(''))};
        else delete batchLanes[lane];
        const records = [...flying.records.slice(0, from), ...retained, ...flying.records.slice(from + n)];
        if (records.length) survivor = {...flying, ...(survivorGen === undefined ? {} : {gen: survivorGen}), records, lanes: batchLanes};
        else clearFlying = true;
      } else clearFlying = true;
    }
    // Journal first: a crash before the cursor moves rolls the new segment back, a crash after it rolls the old ones away.
    writeDurable(journalFile, JSON.stringify({lane, seq, survivor, clearInflight: clearFlying}));
    if (kept.length) {
      const file = segmentPath(lane, seq), temp = file + '.tmp';
      writeDurable(temp, kept.map(line => `${line.gen}\t${line.notBefore}\t${line.at}\t${line.json}\n`).join(''));
      renameSync(temp, file);
      syncDir();
    }
    cursor.lanes[lane] = {seq, offset: 0};
    saveCursor();
    if (survivor) saveJsonFile(inflightFile(streamOf(lane)), survivor, {base});
    else if (clearFlying) rmSync(inflightFile(streamOf(lane)), {force: true});
    for (const segment of old) rmSync(segment.file, {force: true});
    rmSync(journalFile, {force: true});
    open.delete(lane);
    return dropped;
  }

  // Retry age comes from the queued lines, including batches written before this check existed.
  // PostHog timestamps are rounded to their reporting period and cannot prove queue age.
  function retryExpiresAt(batch) {
    const files = segments();
    let oldest = Infinity, record = 0;
    for (const [lane, span] of Object.entries(batch.lanes)) {
      const segment = files.find(file => file.lane === lane && file.seq === span.seq);
      if (!segment) return null;
      const end = record + span.n;
      for (const line of parseLines(readText(segment.file), span.from)) {
        if (line.end > span.to || record === end) break;
        if (line.gen !== batch.gen || line.json !== batch.records[record]) continue;
        oldest = Math.min(oldest, line.at);
        record++;
      }
      if (record !== end) return null;
    }
    return record > 0 && record === batch.records.length ? oldest + OUTBOX_LIMITS.ageMs : null;
  }

  const outbox = {
    /**
     * Append validated records (canonical objects): [{record, gen, notBefore, at}]. `notBefore` is when a record may
     * leave; `gen` is the consent generation. One write and one fsync per lane.
     */
    append(items) {
      const byLane = new Map();
      for (const {record, gen, notBefore = 0, at = now()} of items) {
        // Validate the entire append before any lane writes. Unknown fields must never reach disk.
        const wire = stampRecord(parseQueuedRecord(record), {at,bytes});
        const lane = laneOf(wire), json = JSON.stringify(wire);
        byLane.set(lane, [...(byLane.get(lane) ?? []), {gen, notBefore, at, json}]);
      }
      const committed = new Set();
      try {
        for (const [lane, lines] of byLane) { estimate += appendLines(lane, lines); committed.add(lane); }
      } catch (error) {
        // A write that failed part-way may still have grown a file: forget what is known about sizes, and say which lanes are done.
        open = new Map();
        estimate = totalBytes();
        if (estimate > OUTBOX_LIMITS.totalBytes) outbox.enforceBounds();
        throw Object.assign(error, {committedLanes: committed});
      }
      if (estimate > OUTBOX_LIMITS.totalBytes) outbox.enforceBounds();
    },

    /**
     * The next batch of one stream: records that are due and captured under `gen`, in order, from one uploading service.
     * Records from another generation or past their age limit are dropped on the way. The batch is written to
     * inflight.json at once. Retries keep its ID while all its records remain eligible.
     */
    nextBatch({stream, gen, at = now(), maxRecords = 50, maxBytes = 200 * 1024}) {
      const flying = outbox.inflight(stream);
      if (flying?.gen === gen) {
        const expiresAt = retryExpiresAt(flying);
        if (expiresAt !== null && at <= expiresAt) return {...flying, expiresAt};
      }
      // Reselect from the queue so expired records are skipped and any fresh members can still leave.
      if (flying) rmSync(inflightFile(stream), {force: true});
      const cutoff = at - OUTBOX_LIMITS.ageMs;
      const records = [], spans = {}, drops = [];
      let service = null, size = 0, oldest = Infinity;
      for (const lane of lanes().filter(l => streamOf(l) === stream).sort()) {
        if (service && serviceOf(lane) !== service) continue;
        const here = positionOf(lane), stale = [], expired = [];
        let seq = null, consumedTo = null, taken = 0;
        for (const line of pending(lane)) {
          if (seq !== null && line.seq !== seq) break; // a batch never spans two segments of a lane
          seq = line.seq;
          if (line.bad) { /* skipped */ } else if (line.gen !== gen) stale.push(line); else if (line.at < cutoff) expired.push(line);
          else if (line.notBefore > at || records.length >= maxRecords || (records.length && size + line.json.length > maxBytes) || (stream === 'quota' && records.length >= 1)) break;
          else {
            records.push(line.json);
            oldest = Math.min(oldest, line.at);
            size += line.json.length;
            taken++;
            service = serviceOf(lane);
          }
          consumedTo = line.end;
        }
        const skipped = [...tally('stale_generation', stale), ...tally('dropped_age', expired)];
        if (consumedTo === null) continue;
        // Lines skipped before the first deliverable record are consumed now. Otherwise they are consumed, and counted,
        // when the batch settles, so a batch that is retried or rebuilt never counts them twice.
        if (taken === 0) { report(skipped); cursor.lanes[lane] = {seq, offset: consumedTo}; saveCursor(); continue; }
        drops.push(...skipped);
        spans[lane] = {seq, from: here.seq === seq ? here.offset : 0, to: consumedTo, n: taken};
      }
      if (!records.length) return null;
      const batch = {id: randomId('b', bytes), stream, gen, service, records, lanes: spans, drops};
      saveJsonFile(inflightFile(stream), batch, {base});
      return {...batch, expiresAt: oldest + OUTBOX_LIMITS.ageMs};
    },

    /** The batch that was being sent for `stream` when this process last ran, or null. */
    inflight(stream) {
      try { return JSON.parse(readFileSync(inflightFile(stream), 'utf8')); } catch { return null; }
    },

    /** The request was answered (`outcome` sent) or refused for good (rejected). Records the exact body and moves the cursor. */
    settle(batch, {body, outcome, status, at = now()}) {
      // Only the batch that is in flight can be settled, once: a late or repeated answer changes nothing.
      // Its spans and drops are the persisted ones: maintenance may have moved the batch onto a rewritten lane since the caller got it.
      const flying = outbox.inflight(batch.stream);
      if (flying?.id !== batch.id) return false;
      writeFileSync(join(sentDir, `${batch.id}.json`), body, {mode: 0o600});
      writeFileSync(join(sentDir, `${batch.id}.meta.json`), JSON.stringify({at, outcome, status, bytes: Buffer.byteLength(body), stream: batch.stream}), {mode: 0o600});
      for (const [lane, span] of Object.entries(flying.lanes)) {
        const segment = segments().find(s => s.lane === lane && s.seq === span.seq);
        // The cursor never passes the bytes on disk. A span reaches past its segment only if the segment lost its tail.
        const to = segment ? Math.min(span.to, statSync(segment.file).size) : span.to;
        const here = positionOf(lane);
        if (span.seq > here.seq || (span.seq === here.seq && to > here.offset)) cursor.lanes[lane] = {seq: span.seq, offset: to};
        // A fully consumed segment that appends no longer go to is removed.
        if (segment && cursor.lanes[lane].offset >= statSync(segment.file).size && open.get(lane)?.seq !== span.seq) rmSync(segment.file, {force: true});
      }
      saveCursor();
      rmSync(inflightFile(batch.stream), {force: true});
      report(flying.drops ?? []);
      outbox.enforceSent();
      return true;
    },

    /** The consent transition: queued records of `streams` that carry `fromGen` move to `gen`; all others are dropped. */
    carry({streams, fromGen, gen}) {
      for (const stream of ['counts', 'quota', 'diagnostics']) {
        const batch = outbox.inflight(stream);
        if (batch && (!streams.includes(stream) || batch.gen !== fromGen)) rmSync(inflightFile(stream), {force: true});
      }
      for (const lane of lanes()) {
        drop('stale_generation', rewrite(lane, line => (streams.includes(streamOf(lane)) && line.gen === fromGen ? gen : null), {survivorGen: gen}));
      }
    },

    /** Drop queued records with these names: the allowance totals, once their choice is withdrawn. They go under the reason the
     *  catalog already reports for a consent change; everything else stays. */
    dropNamed(names) {
      for (const lane of lanes()) drop('stale_generation', rewrite(lane, line => (names.includes(nameOf(line.json)) ? null : line.gen), {dropNames: names}));
    },

    /** Delete queued records (all, or of some streams). With no argument it also deletes the sent ledger. */
    purge({streams} = {}) {
      if (streams) for (const stream of streams) rmSync(inflightFile(stream), {force: true});
      else {
        clearInflight();
        rmSync(journalFile, {force: true});
        for (const name of readdirSync(root)) if (name.endsWith('.jsonl.tmp')) rmSync(join(root, name), {force: true});
      }
      for (const segment of segments()) if (!streams || streams.includes(streamOf(segment.lane))) rmSync(segment.file, {force: true});
      for (const lane of Object.keys(cursor.lanes)) if (!streams || streams.includes(streamOf(lane))) delete cursor.lanes[lane];
      open = new Map();
      saveCursor();
      if (!streams) for (const name of readdirSync(sentDir)) rmSync(join(sentDir, name), {force: true});
    },

    /** Age and size bounds. Counts are evicted last; each eviction is reported through onDrop. */
    enforceBounds(at = now()) {
      const cutoff = at - OUTBOX_LIMITS.ageMs;
      for (const lane of lanes()) {
        if (pending(lane).some(line => !line.bad && line.at < cutoff)) drop('dropped_age', rewrite(lane, line => (line.at >= cutoff ? line.gen : null)));
      }
      while ((estimate = totalBytes()) > OUTBOX_LIMITS.totalBytes) {
        const order = segments().sort((a, b) => EVICTION_ORDER.indexOf(streamOf(a.lane)) - EVICTION_ORDER.indexOf(streamOf(b.lane)) || a.seq - b.seq);
        const victim = order[0];
        if (!victim) break;
        const at2 = positionOf(victim.lane);
        const lines = parseLines(readText(victim.file), victim.seq === at2.seq ? at2.offset : 0);
        rmSync(victim.file, {force: true});
        const flying = outbox.inflight(streamOf(victim.lane));
        if (flying?.lanes?.[victim.lane]?.seq === victim.seq) rmSync(inflightFile(streamOf(victim.lane)), {force: true}); // its records are the ones evicted
        cursor.lanes[victim.lane] = {seq: victim.seq + 1, offset: 0};
        open.delete(victim.lane);
        drop('dropped_bytes', lines);
        saveCursor();
      }
    },

    enforceSent(at = now()) {
      const files = readdirSync(sentDir).filter(name => !name.endsWith('.meta.json')).map(name => {
        const meta = (() => { try { return JSON.parse(readFileSync(join(sentDir, name.replace(/\.json$/, '.meta.json')), 'utf8')); } catch { return null; } })();
        return {name, at: meta?.at ?? 0, size: statSync(join(sentDir, name)).size};
      }).sort((a, b) => a.at - b.at);
      let total = files.reduce((sum, f) => sum + f.size, 0);
      for (const file of files) {
        if (total <= OUTBOX_LIMITS.sentBytes && file.at >= at - OUTBOX_LIMITS.ageMs) continue;
        rmSync(join(sentDir, file.name), {force: true});
        rmSync(join(sentDir, file.name.replace(/\.json$/, '.meta.json')), {force: true});
        total -= file.size;
      }
    },

    /** What is queued (valid under `gen`) and what was sent in the last `sentDays` days: the exact bytes. */
    inspect({gen, sentDays = 7, at = now()}) {
      const out = [];
      for (const lane of lanes().sort()) {
        for (const line of pending(lane)) {
          if (line.bad || line.gen !== gen || line.at < at - OUTBOX_LIMITS.ageMs) continue;
          out.push({stream: streamOf(lane), state: 'queued', at: line.at, bytes: Buffer.byteLength(line.json), status: null, body: line.json});
        }
      }
      for (const name of readdirSync(sentDir).filter(n => n.endsWith('.meta.json'))) {
        let meta;
        try { meta = JSON.parse(readFileSync(join(sentDir, name), 'utf8')); } catch { continue; }
        if (meta.at < at - sentDays * 86400000) continue;
        out.push({stream: meta.stream, state: meta.outcome, at: meta.at, bytes: meta.bytes, status: meta.status, body: readText(join(sentDir, name.replace(/\.meta\.json$/, '.json')))});
      }
      return out.sort((a, b) => b.at - a.at);
    },

    stats() {
      const queued = {counts: 0, diagnostics: 0, quota: 0};
      for (const lane of lanes()) queued[streamOf(lane)] += pending(lane).filter(line => !line.bad).length;
      return {queued, bytes: totalBytes()};
    },

    /** Uploads stop for good for a build version when the server answers 401 or 403. */
    halted: () => cursor.halt,
    halt(version) { cursor.halt = version; saveCursor(); },
  };

  return outbox;
}
