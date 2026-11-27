import {readFileSync} from 'node:fs';

/** Packaging writes VERSION beside the installed app; a source checkout is unknown. */
export function readFaravanVersion(file = new URL('../../VERSION', import.meta.url)) {
  try {
    const text=readFileSync(file,'utf8').trim();
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text)?text:null;
  } catch {return null;}
}
