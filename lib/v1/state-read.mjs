import fs from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

// A stored JSON file is in one of three states. `absent` means ENOENT and nothing else: the file was never written, so a
// writer may start empty. `unknown` is every other outcome (permission, I/O, not a file, bad JSON): the file may hold real
// history, so a writer must not replace it and a reader must not show it as empty. `present` carries the parsed value.
export const STATE_UNKNOWN = 'state_unknown';

export class StateUnknownError extends Error {
  constructor(file, cause) {
    super(`could not read ${path.basename(file)}; the saved file was left unchanged${cause?.message ? ` (${cause.message})` : ''}`);
    this.name = 'StateUnknownError';
    this.code = STATE_UNKNOWN;
    this.file = file;
    this.cause = cause;
  }
}

const present = value => ({state: 'present', value});
const absent = () => ({state: 'absent'});
export const unknownState = error => ({state: 'unknown', error});

const classify = error => (error?.code === 'ENOENT' ? absent() : unknownState(error));

function parse(raw) {
  try { return present(JSON.parse(raw)); } catch (error) { return unknownState(error); }
}

export function readJsonState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { return classify(error); }
  return parse(raw);
}

export async function readJsonStateAsync(file, {maxBytes} = {}) {
  let raw;
  try {
    if (maxBytes !== undefined && (await stat(file)).size > maxBytes) return unknownState(new Error('oversized'));
    raw = await readFile(file, 'utf8');
  } catch (error) { return classify(error); }
  return parse(raw);
}
