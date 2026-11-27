// Shared by the telemetry contract tests: the golden fixtures under tests/telemetry/golden.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN = join(fileURLToPath(new URL('../telemetry/golden', import.meta.url)));
export const readGolden = name => readFileSync(join(GOLDEN, name), 'utf8');
export const goldenNames = suffix => readdirSync(GOLDEN).filter(name => name.endsWith(suffix)).sort();

/** [{name, bytes, record, inbox}]: one per `<entry>.record.json`. `inbox` is the producer's file when the entry has an `.inbox.json`. */
export function goldenRecords() {
  return goldenNames('.record.json').map(file => {
    const name = file.slice(0, -'.record.json'.length);
    const bytes = readGolden(file);
    const inboxFile = name + '.inbox.json';
    return {name, bytes, record: JSON.parse(bytes), inbox: readdirSync(GOLDEN).includes(inboxFile) ? JSON.parse(readGolden(inboxFile)) : null};
  });
}
