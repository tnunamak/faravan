export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context);
  let source=String(result.source);
  if(url.endsWith('/lib/v1/device.mjs'))source=source.replace('function read(file,fallback) {',"function read(file,fallback) { globalThis.__macUiReads?.(file);");
  else if(url.endsWith('/lib/v1/job-meta.mjs'))source=source.replace('async function load() {',"async function load() { globalThis.__macUiReads?.(file);");
  else return result;
  return {...result,source};
}
