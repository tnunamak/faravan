import {useState,useEffect,useRef} from 'preact/hooks';
import {errorMessage} from './helpers.mjs';
import {outputPreviewBudget,imageWithinPixelLimit} from './output-preview-budget.mjs';

export const MAX_ACTIVE_PREVIEWS = 2;
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/** Keeps at most `max` previews open; opening another closes the oldest, so object URLs stay bounded. */
export function createPreviewBudget(max = MAX_ACTIVE_PREVIEWS) {
  const open = [];
  return {
    open(close) {
      open.push(close);
      while (open.length > max) open.shift()();
    },
    release(close) {
      const index = open.indexOf(close);
      if (index >= 0) open.splice(index, 1);
    },
    get size() { return open.length; },
  };
}
const budget = createPreviewBudget();

/** One bounded fetch: refuse an advertised or actual body at or above the preview limit. */
export async function fetchPreviewBlob(api, url, signal) {
  const response = await api.request(url.slice('/api/'.length), {signal});
  const advertised = Number(response.headers?.get?.('content-length'));
  if (advertised >= MAX_PREVIEW_BYTES) { await response.body?.cancel(); throw new Error('preview too large'); }
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>=MAX_PREVIEW_BYTES){await reader.cancel();throw new Error('preview too large');}chunks.push(value);}
    }finally{reader.releaseLock();}
    return new Blob(chunks,{type:response.headers.get('content-type')||'application/octet-stream'});
  }
  const blob = await response.blob();
  if (blob.size >= MAX_PREVIEW_BYTES) throw new Error('preview too large');
  return blob;
}

/**
 * Click-to-show image preview. While shown, the image holds a page-wide lease (byte, count and
 * concurrency caps), is size- and dimension-checked before decode, and is released when it
 * scrolls away or the reader hides it. SVG and undecodable images are download-only.
 */
export function ImagePreview({file,api,inline=false}) {
  const [shown,setShown] = useState(inline), [source,setSource] = useState(''), [failed,setFailed] = useState(false), [limited,setLimited] = useState(false), [smallSize,setSmallSize]=useState(''), [problem,setProblem]=useState(null), [attempt,setAttempt]=useState(0), [evicted,setEvicted]=useState(false);
  const figure = useRef(), closeRef = useRef(null), sourceRef = useRef('');
  const close = () => { setShown(false); setSource(''); };
  useEffect(() => {
    if (!shown) return;
    const evict = () => { setEvicted(true); close(); };
    budget.open(evict);
    if (!api) return () => budget.release(evict);
    let controller, lease, objectUrl, started = false, disposed = false, observer;
    const release = () => {
      controller?.abort(); controller = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (sourceRef.current === objectUrl) sourceRef.current = '';
      objectUrl = null;
      lease?.release(); lease = null;
    };
    closeRef.current = release;
    const offscreen = () => { if (started) { release(); started = false; if (!disposed) setSource(''); } };
    const load = async () => {
      if (started || disposed) return;
      started = true;
      setFailed(false); setLimited(false); setProblem(null);
      const mine = controller = new AbortController();
      try {
        let readProblem=null;
        const acquired = await outputPreviewBudget.acquire(async () => {
          try {
            const blob = await fetchPreviewBlob(api, file.preview.url, mine.signal);
            return await imageWithinPixelLimit(blob) ? blob : null;
          } catch (error) {
            // The budget releases failed loads as null. Preserve the boundary
            // problem separately so a lost connection is not called a size limit.
            if(!mine.signal.aborted&&error?.name!=='AbortError')readProblem=error?.problem??{code:'image_preview_unavailable'};
            return null;
          }
        }, {signal: mine.signal});
        if(readProblem&&!disposed&&!mine.signal.aborted){setProblem(readProblem);setFailed(true);return;}
        if (!acquired) { if (!disposed && !mine.signal.aborted) setLimited(true); return; }
        if (disposed || mine.signal.aborted) { acquired.release(); return; }
        lease = acquired;
        objectUrl = URL.createObjectURL(lease.blob);
        sourceRef.current = objectUrl;
        setSource(objectUrl);
      } catch (error) { if (!disposed && error?.name !== 'AbortError') {setProblem(error?.problem??{code:'image_preview_unavailable'});setFailed(true);} }
    };
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(); else offscreen(); }, {rootMargin:'400px'});
      observer.observe(figure.current);
    } else {
      const check = () => {
        const rect = figure.current?.getBoundingClientRect();
        if (rect && rect.bottom >= -400 && rect.top <= innerHeight + 400) void load(); else offscreen();
      };
      window.addEventListener('scroll',check,{passive:true});
      window.addEventListener('resize',check,{passive:true});
      observer = {disconnect() { window.removeEventListener('scroll',check); window.removeEventListener('resize',check); }};
      check();
    }
    return () => { disposed = true; observer?.disconnect(); release(); closeRef.current = null; budget.release(evict); };
  }, [shown,api,file.preview.url,attempt]);
  const unavailable = smallSize ? smallSize+' pixels · too small to preview. Use Download to keep the image.' : 'The image could not be decoded. Use Download to keep the file.';
  if (failed) return <figure ref={figure} class="job-image-preview ph-no-capture" data-telemetry-private="image-preview"><p class="t-sm t-2">{problem?errorMessage(problem):unavailable}</p><button type="button" class="btn btn-secondary" onClick={() => { setFailed(false); setProblem(null); setSmallSize(''); setShown(true); setAttempt(value=>value+1); }}>Try preview again</button></figure>;
  if (!shown) return <figure class="job-image-preview ph-no-capture" data-telemetry-private="image-preview">
    {evicted&&<p class="t-sm t-2" role="status">Closed to keep the page within its preview limit — Show again to reopen.</p>}
    <button type="button" class="btn btn-secondary" aria-expanded={shown} onClick={() => { setEvicted(false); setShown(true); }}>Show image preview</button>
  </figure>;
  return <figure ref={figure} class={('job-image-preview' + (!source && !limited && api ? ' is-loading' : '')) + ' ph-no-capture'} data-telemetry-private="image-preview">
    {!api ? <p class="t-sm t-2">This image cannot be previewed here.</p> : source ? <img src={source} alt={'Preview of ' + file.path} onLoad={event=>{if(event.currentTarget.naturalWidth<8||event.currentTarget.naturalHeight<8){setSmallSize(event.currentTarget.naturalWidth+' × '+event.currentTarget.naturalHeight);closeRef.current?.();setFailed(true);close();}}} onError={() => { if (sourceRef.current !== source) return; closeRef.current?.(); setFailed(true); close(); }} /> :
      limited ? <p class="t-sm t-2">This image cannot be previewed within the page’s limits. Download the result to review it.</p> :
        <p class="t-sm t-2" role="status">Loading image preview…</p>}
    <button type="button" class="btn btn-secondary" aria-expanded={shown} onClick={close}>Hide image preview</button>
  </figure>;
}
