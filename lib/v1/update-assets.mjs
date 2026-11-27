// Optional, signed asset metadata extends the legacy schema-1 Linux manifest.
// Older clients keep using its unchanged tarball fields; Mac clients never do.
// The Linux .deb is the top-level "deb" object, not an asset: older clients validate assets and refuse kinds they
// do not know, so a deb asset would break their update check.
const LIMIT=256*1024*1024;
const LINUX_KINDS=['tarball'];
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
function validateDeb(deb) {
  if(!deb||typeof deb!=='object'||Array.isArray(deb)||Object.keys(deb).length!==5||['arch','channel','size','sha256','file'].some(k=>!Object.hasOwn(deb,k)))bad();
  if(!['arm64','x64'].includes(deb.arch)||typeof deb.channel!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(deb.channel))bad();
  if(!Number.isSafeInteger(deb.size)||deb.size<1||deb.size>LIMIT||typeof deb.sha256!=='string'||!/^[a-f0-9]{64}$/.test(deb.sha256))bad();
  if(typeof deb.file!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.deb$/.test(deb.file))bad();
}
export function validateManifestAssets(manifest) {
  if(manifest.deb!==undefined)validateDeb(manifest.deb);
  const preview=typeof manifest.version==='string'&&manifest.version.includes('-preview.');
  if(preview&&!absoluteHTTPS(manifest.tarball))bad();
  if(manifest.assets===undefined&&manifest.assets_schema===undefined)return [];
  if(manifest.assets_schema!==1||!Array.isArray(manifest.assets)||manifest.assets.length<1||manifest.assets.length>16)bad();
  const identities=new Set();
  for(const asset of manifest.assets) {
    const linux=asset?.platform==='linux',required=linux?fields.filter(k=>k!=='bundleId'):fields;
    if(!asset||typeof asset!=='object'||Array.isArray(asset)||Object.keys(asset).length!==required.length||required.some(k=>!Object.hasOwn(asset,k))||
      (linux?(!['arm64','x64'].includes(asset.arch)||!LINUX_KINDS.includes(asset.kind)):
        (asset.platform!=='darwin'||!['arm64','x64','universal'].includes(asset.arch)||asset.kind!=='macos-app-zip'))||
      typeof asset.channel!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(asset.channel)||
      (!linux&&(typeof asset.bundleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/.test(asset.bundleId)))||
      !(linux?absoluteHTTPS(asset.url):validURL(asset.url))||(preview&&!absoluteHTTPS(asset.url))||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>LIMIT||
      typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))bad();
    // Legacy Linux clients consume the top-level fields for the tarball; do not sign a contradictory tarball target.
    if(linux&&asset.kind==='tarball'&&(asset.url!==manifest.tarball||asset.size!==manifest.size||asset.sha256!==manifest.sha256))bad();
    const key=[asset.platform,asset.arch,asset.kind,asset.channel,asset.bundleId].join('\0');
    if(identities.has(key))throw new Error('Duplicate update asset identity.');
    identities.add(key);
  }
  return manifest.assets;
}
export function selectUpdateAsset(manifest,{platform,arch,channel,bundleId}) {
  const assets=validateManifestAssets(manifest);
  if(platform==='linux') {
    const linux=assets.filter(a=>a.platform==='linux');
    if(linux.length||manifest.version?.includes('-preview.')) {
      const selected=linux.find(a=>a.kind==='tarball'&&a.arch===arch&&a.channel===channel);
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
