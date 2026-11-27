import {verifyManifest} from '../lib/v1/self-update.mjs';
import {UPDATE_PUBLIC_KEY} from '../lib/v1/update-key.mjs';

export const candidateURL='https://tnunamak.github.io/faravan-updates/candidate/update.json';
// Promotion currently publishes the signed candidate at preview/ and marks its release latest.
export const latestURL='https://tnunamak.github.io/faravan-updates/preview/update.json';
export function manifestCommit(manifest) {
  if(!/^[a-f0-9]{40}$/.test(manifest.sourceSha??''))throw Error('manifest lacks sourceSha');
  return manifest.sourceSha;
}
export async function readManifest(url,{fetch:read=fetch,publicKey=UPDATE_PUBLIC_KEY}={}) {
  const get=async path=>{
    const response=await read(path,{cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`HTTP ${response.status}: ${path}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const bytes=await get(url),signature=await get(url+'.sig');
  return verifyManifest(bytes,signature.toString('utf8'),publicKey);
}
