// Frozen compatibility fixture from e214a6a5:lib/v1/update-assets.mjs.
// Optional, signed asset metadata extends the legacy schema-1 Linux manifest.
// Older clients keep using its unchanged tarball fields; Mac clients never do.
const LIMIT=256*1024*1024;
const fields=['platform','arch','kind','channel','bundleId','url','size','sha256'];
const bad=()=>{throw new Error('The update asset manifest is invalid.');};
function absoluteHTTPS(value) {
  if(typeof value!=='string'||!/^https:\/\//.test(value))return false;
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash;}
  catch{return false;}
}
function validURL(value) {
  if(typeof value!=='string')return false;
  if(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(value))return true;
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&url.pathname.endsWith('.zip');}
  catch{return false;}
}
export function validateManifestAssets(manifest) {
  const preview=typeof manifest.version==='string'&&manifest.version.includes('-preview.');
  if(preview&&!absoluteHTTPS(manifest.tarball))bad();
  if(manifest.assets===undefined&&manifest.assets_schema===undefined)return [];
  if(manifest.assets_schema!==1||!Array.isArray(manifest.assets)||manifest.assets.length<1||manifest.assets.length>16)bad();
  const identities=new Set();
  for(const asset of manifest.assets) {
    const linux=asset?.platform==='linux',required=linux?fields.filter(k=>k!=='bundleId'):fields;
    if(!asset||typeof asset!=='object'||Array.isArray(asset)||Object.keys(asset).length!==required.length||required.some(k=>!Object.hasOwn(asset,k))||
      (linux?(!['arm64','x64'].includes(asset.arch)||asset.kind!=='tarball'):
        (asset.platform!=='darwin'||!['arm64','x64','universal'].includes(asset.arch)||asset.kind!=='macos-app-zip'))||
      typeof asset.channel!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(asset.channel)||
      (!linux&&(typeof asset.bundleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/.test(asset.bundleId)))||
      !(linux?absoluteHTTPS(asset.url):validURL(asset.url))||(preview&&!absoluteHTTPS(asset.url))||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>LIMIT||
      typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))bad();
    // Legacy Linux clients consume these fields; do not sign contradictory targets.
    if(linux&&(asset.url!==manifest.tarball||asset.size!==manifest.size||asset.sha256!==manifest.sha256))bad();
    const key=[asset.platform,asset.arch,asset.kind,asset.channel,asset.bundleId].join('\0');
    if(identities.has(key))throw new Error('Duplicate update asset identity.');
    identities.add(key);
  }
  return manifest.assets;
}
export function selectUpdateAsset(manifest,{platform,arch,channel,bundleId}) {
  const assets=validateManifestAssets(manifest);
  if(platform==='linux') {
    const matches=assets.filter(a=>a.platform==='linux');
    if(matches.length||manifest.version?.includes('-preview.')) {
      const selected=matches.find(a=>a.arch===arch&&a.channel===channel);
      if(!selected)throw new Error('No compatible update asset.');
      return {...selected};
    }
    return {kind:'tarball',url:manifest.tarball,size:manifest.size,sha256:manifest.sha256};
  }
  if(platform!=='darwin'||!['arm64','x64'].includes(arch))throw new Error('No compatible update asset.');
  const matches=assets.filter(a=>a.platform===platform&&a.channel===channel&&a.bundleId===bundleId);
  const selected=matches.find(a=>a.arch===arch)??matches.find(a=>a.arch==='universal');
  if(!selected)throw new Error('No compatible update asset.');
  return {...selected};
}
