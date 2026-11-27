// Finished results are immutable. Keep their preview across route changes, independent of activity.
const previews=new WeakMap();
export function loadHomePreview(api,path) {
  let cache=previews.get(api);
  if(!cache){cache=new Map();previews.set(api,cache);}
  const existing=cache.get(path);
  if(existing && (existing.settled || Date.now()-existing.started < 10000))return existing.request;
  const entry={started:Date.now(),settled:false};
  const request=api.get(path,AbortSignal.timeout(10000)).then(value=>{entry.settled=true;return value;},error=>{
    if(cache.get(path)===entry)cache.delete(path);
    throw error;
  });
  entry.request=request;
  cache.set(path,entry);
  if(cache.size>20)cache.delete(cache.keys().next().value);
  return request;
}

export const loadHomeReceipt=(api,changesPath)=>loadHomePreview(api,changesPath.replace('/changes','/receipt'));
