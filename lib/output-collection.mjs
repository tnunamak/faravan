import { mkdtemp, open, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const failure = (code, message) => Object.assign(new Error(message), { code });

// This directory is host-private and is never supplied as an sbx workspace.
// The transport receives no destination pathname: only this process writes it.
export async function collectOutputStream(stream, maxBytes, { stageRoot = os.tmpdir() } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw failure('output_too_large', 'Invalid output byte budget.');
  const directory = await mkdtemp(path.join(stageRoot, 'faravan-output-'));
  const destination = path.join(directory, 'output');
  let file;
  try {
    file = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
    const original = await file.stat();
    if (!original.isFile()) throw failure('output_invalid', 'Output staging is not a regular file.');
    let size = 0;
    for await (const value of stream) {
      const chunk = Buffer.from(value);
      if (chunk.length > maxBytes - size) throw failure('output_too_large', 'Declared output exceeds the job output byte limit.');
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, size + offset);
        if (!bytesWritten) throw failure('output_copy_failed', 'Output staging write made no progress.');
        offset += bytesWritten;
      }
      size += chunk.length;
    }
    const entry = await lstat(destination);
    if (!entry.isFile() || entry.dev !== original.dev || entry.ino !== original.ino) {
      throw failure('output_invalid', 'Output staging entry was replaced.');
    }
    // Hash and return bytes from the descriptor that received the transfer.
    // A pathname replacement can never redirect this read to another file.
    const hash = createHash('sha256');
    const chunks = [];
    let position = 0;
    while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw failure('output_invalid', 'Output staging changed during collection.');
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes); chunks.push(bytes); position += bytesRead;
    }
    if ((await file.stat()).size !== size) throw failure('output_invalid', 'Output staging changed during collection.');
    return { sha256: hash.digest('hex'), size, buffer: Buffer.concat(chunks, size) };
  } finally {
    try { await file?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
