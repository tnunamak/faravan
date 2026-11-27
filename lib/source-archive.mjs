import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ArchiveError, extractArchive } from './archive.mjs';

// Lender-owned limits, independent of the sender's composer and resource modes.
export const SOURCE_ARCHIVE_POLICY = Object.freeze({ maxEntries: 1000, maxTotalBytes: 20 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024, maxPathLength: 1024, maxMetadataBytes: 64 * 1024, maxDepth: 64, maxTrailingBytes: 10240 });
export const SOURCE_ARCHIVE_INPUT_BYTES = SOURCE_ARCHIVE_POLICY.maxTotalBytes + SOURCE_ARCHIVE_POLICY.maxEntries * 1024 + 10240;

/** Inflation, validation and writes share a bounded worker lifetime. Await its
 * termination before callers remove the prepared workspace, including on abort. */
export async function extractSourceArchive(input, destination, { gzip, signal, timeoutMs = 10_000, limits = {} } = {}) {
  signal?.throwIfAborted();
  if (!(input instanceof Uint8Array) || input.byteLength > SOURCE_ARCHIVE_INPUT_BYTES)
    throw new ArchiveError('too_large', 'Source archive exceeds the lender input limit.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new ArchiveError('malformed', 'Invalid source extraction deadline.');
  const policy = { ...SOURCE_ARCHIVE_POLICY };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(policy, key) || !Number.isSafeInteger(value) || value < 0 || value > policy[key])
      throw new ArchiveError('malformed', 'Source policy may only tighten lender limits.');
    policy[key] = value;
  }
  const worker = new Worker(new URL(import.meta.url), { env: {},
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    workerData: { sourceArchive: true, input, destination, options: { ...policy, gzip, preserveExecutable: true, allowGit: true } } });
  let timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason ?? new ArchiveError('cancelled', 'Source extraction cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => reject(new ArchiveError('source_timeout', 'Source extraction exceeded its deadline.')), timeoutMs);
      worker.once('message', result => result.error
        ? reject(new ArchiveError(result.error.code, result.error.message)) : resolve(result.summary));
      worker.once('error', () => reject(new ArchiveError('invalid_source', 'Source extraction worker failed.')));
      worker.once('exit', () => reject(new ArchiveError('invalid_source', 'Source extraction worker exited without a result.')));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

if (!isMainThread && workerData?.sourceArchive === true) {
  try {
    const summary = await extractArchive(workerData.input, workerData.destination, workerData.options);
    parentPort.postMessage({ summary });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code ?? 'invalid_source', message: error.message } });
  }
}
