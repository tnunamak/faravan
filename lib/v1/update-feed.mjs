import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const CANDIDATE_FEED_URL='https://tnunamak.github.io/faravan-updates/candidate/update.json';
export async function readEarlyBuilds(home) {
  try{return JSON.parse(await readFile(join(home,'v1/app-settings.json'),'utf8')).earlyBuilds===true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
export function updateFeedURL({earlyBuilds=false,override}={}) {
  return override||(earlyBuilds?CANDIDATE_FEED_URL:undefined);
}
