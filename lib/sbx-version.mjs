export const SBX_MIN_VERSION=Object.freeze([0,51,0]);
export function supportedSbxVersion(output) {
  const match=/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.exec(output);
  if(!match)return false;
  const [major,minor,patch]=match.slice(1).map(Number),[minMajor,minMinor,minPatch]=SBX_MIN_VERSION;
  return major>minMajor||major===minMajor&&(minor>minMinor||minor===minMinor&&patch>=minPatch);
}
