// Run with node consent-variants.mjs <release source checkout> <fixture directory>.
// Uses only the selected release's atomic state writer to save two copies of the
// rejected-policy fixture whose provider consent is not all-true.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [source,destination]=process.argv.slice(2).map(value=>resolve(value));
const {saveJsonFile}=await import(pathToFileURL(join(source,'lib/local-state.mjs')));
const base=JSON.parse(await readFile(join(destination,'invalid-policy.json'),'utf8'));
for(const [name,consent] of [['false',{claude:false,codex:false}],['mixed',{claude:true,codex:false}]]) {
 const state=structuredClone(base);state.limits.lendingPolicy.providerConsent=consent;
 saveJsonFile(join(destination,'invalid-policy-'+name+'.json'),state,{base:destination});
}
console.log('wrote consent variants in '+destination);
