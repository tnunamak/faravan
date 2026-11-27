// Both packaged and tarball updates advance only within stable or preview.
// A legacy preview-YYYYMMDD install identity is not a version-date boundary.
export function parseUpdateVersion(value) {
    if(typeof value!=='string')return null;
    const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(\d{8})\.(0|[1-9]\d*))?$/.exec(value);
    if(!match)return null;
    const nums=[match[1],match[2],match[3],...(match[4]===undefined?[]:[match[4],match[5]])].map(Number);
    if(nums.some(n=>!Number.isSafeInteger(n)))return null;
    if(match[4]===undefined)return nums;
    const date=match[4], iso=date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);
    const parsed=new Date(iso+'T00:00:00.000Z');
    if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==iso)return null;
    return nums;
}
function parseMacUpdateVersion(value,channel) {
    return channel === 'faravan' ? parseUpdateVersion(value) : null;
}
export const validMacUpdateVersion=(value,channel)=>parseMacUpdateVersion(value,channel)!==null;
export function isNewerMacUpdate(candidate,current,channel) {
  const a=parseMacUpdateVersion(candidate,channel),b=parseMacUpdateVersion(current,channel);if(!a||!b||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
