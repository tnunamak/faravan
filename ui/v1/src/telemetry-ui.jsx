import {useEffect, useRef, useState} from 'preact/hooks';
import {Card, Icon} from './ds/index.mjs';
import {TELEMETRY_COPY} from '../../../lib/v1/telemetry/copy.mjs';
import {privacyCardModel, firstRunModel, chooseBody, recordingsBody} from './telemetry-model.mjs';
import {previewModel} from './telemetry-preview.mjs';
import {telemetryStore} from './telemetry-store.mjs';

export const PREVIEW_HREF = '#/you/data/telemetry';
const RESET_CONFIRM = 'Get a new random ID? A new one starts now, and everything waiting to be sent is deleted.';

function useView(api, initial, {reload = false} = {}) {
  const [view, setView] = useState(initial ?? telemetryStore.get());
  useEffect(() => {
    const off = telemetryStore.subscribe(setView);
    if (api && (reload || !telemetryStore.get())) telemetryStore.load(api);
    return off;
  }, [api]);
  return view;
}

// Runs one change and keeps the person's place: a failure is said once, in words, next to what they pressed.
function useChange(api) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const run = async (path, body) => {
    if (pending) return;
    setPending(true); setError('');
    try { await telemetryStore.post(api, path, body); }
    catch (failure) { setError(failure?.message || 'That did not save. Try again.'); }
    finally { setPending(false); }
  };
  return {pending, error, run};
}

/** Settings → You → Your data. */
export function PrivacyCard({api, view: initial = null, confirmReset = message => (typeof confirm === 'function' ? confirm(message) : true)}) {
  const view = useView(api, initial, {reload: true});
  const [details, setDetails] = useState(false), [asked, setAsked] = useState(null);
  const change = useChange(api);
  const choose = async level => { setAsked(level); await change.run('telemetry/choose', chooseBody(level)); setAsked(null); };
  if (!view) return <Card as="section" class="telemetry-card ph-no-capture" data-telemetry-private="telemetry-ui" aria-labelledby="telemetry-title"><div class="card-pad stack-3">
    <h3 id="telemetry-title" class="t-title3">{TELEMETRY_COPY.settings.title}</h3><p class="t-sm t-2" role="status">Loading…</p></div></Card>;
  const model = privacyCardModel(view, {asked});
  return <Card as="section" class="telemetry-card ph-no-capture" data-telemetry-private="telemetry-ui" aria-labelledby="telemetry-title"><div class="card-pad stack-4">
    <div class="stack-2"><h3 id="telemetry-title" class="t-title3">{model.title}</h3><p class="t-sm">{model.intro}</p></div>
    <p class="t-sm t-2">{model.retention}</p>
    <p class="t-sm t-2">{model.turnOff}</p>
    {model.unavailable && <p class="t-sm" role="status">{model.unavailable}</p>}
    <fieldset class="telemetry-choices" disabled={model.disabled || change.pending} aria-labelledby="telemetry-title">
      {model.choices.map(choice => <label key={choice.level} class={'telemetry-choice' + (choice.checked ? ' selected' : '')}>
        <input type="radio" name="telemetry-level" value={choice.level} checked={choice.checked}
          onChange={() => choose(choice.level)} />
        <span><b>{choice.label}</b><span class="t-sm t-2 telemetry-detail">{choice.detail}</span></span>
      </label>)}
    </fieldset>
    <label class={'telemetry-choice' + (model.recordings.checked ? ' selected' : '')}>
      <input type="checkbox" name="telemetry-recordings" checked={model.recordings.checked} disabled={model.disabled || model.recordings.disabled || change.pending}
        onChange={event => change.run('telemetry/choose', recordingsBody(event.currentTarget.checked))} />
      <span><b>{model.recordings.label}</b><span class="t-sm t-2 telemetry-detail">{model.recordings.detail}</span></span>
    </label>
    {model.envLine && <p class="t-sm" role="status">{model.envLine}</p>}
    {change.error && <p class="t-sm telemetry-error" role="alert">{change.error}</p>}
    <p class="t-sm t-2">{model.readers}</p>
    <div class="telemetry-links hstack-2 wrap">
      <a href={PREVIEW_HREF}>{model.links.preview}</a><span aria-hidden="true">·</span>
      <button type="button" class="link-button" aria-expanded={details ? 'true' : 'false'} aria-controls="telemetry-details" onClick={() => setDetails(open => !open)}>{model.links.privacy}</button><span aria-hidden="true">·</span>
      <button type="button" class="link-button" disabled={change.pending} onClick={() => { if (confirmReset(RESET_CONFIRM)) change.run('telemetry/reset-id'); }}>{model.links.resetId}</button>
    </div>
    <section id="telemetry-details" class="telemetry-details" hidden={!details} aria-label={model.links.privacy}>
      <ul class="stack-2">{TELEMETRY_COPY.privacyDetails.map(line => <li key={line} class="t-sm">{line}</li>)}</ul>
    </section>
  </div></Card>;
}

// Dismissing the one-line notice is a browser-local preference; it posts nothing, so the consent record is untouched.
const LINE_DISMISSED = 'faravan-telemetry-unavailable-dismissed';
const readLineDismissed = () => { try { return localStorage.getItem(LINE_DISMISSED) === '1'; } catch { return false; } };
const writeLineDismissed = () => { try { localStorage.setItem(LINE_DISMISSED, '1'); } catch {} };
// Dismissing the main notice is browser-local and separate from the server's notice record, which a failed acknowledgment
// leaves pending. It never turns telemetry on and never stands in for consent. The version suffix lets a later notice ask
// again. If storage is denied, the dismissal lasts only for this page, so the notice is not acknowledged there at all:
// a reload would show it again and record it, which would not respect the dismissal.
const NOTICE_DISMISSED = 'faravan-telemetry-notice-dismissed-v1';
const readNoticeMemory = () => { try { return {dismissed: localStorage.getItem(NOTICE_DISMISSED) === '1', durable: true}; } catch { return {dismissed: false, durable: false}; } };
const writeNoticeDismissed = () => { try { localStorage.setItem(NOTICE_DISMISSED, '1'); } catch {} };

/**
 * Setup notice: a small corner notice that blocks nothing. Showing it records the notice and enables the default, so
 * sending can start only after it was on screen. Closing it or following its link only hides it; the notice is already
 * recorded as shown, so it does not return on a later visit. The on/off choice lives in Settings → Your data.
 * A build that cannot upload shows one line instead: it offers no choice and never records the notice as shown, so a
 * later build with an upload destination still shows the notice before anything is sent.
 */
// Fixed local message for a failed notice acknowledgment: the server's error
// text is never shown, and no choice is recorded by the retry.
const NOTICE_ACK_FAILED = 'The notice could not be recorded. Try again.';

export function FirstRunCard({api, view: initial = null}) {
  const view = useView(api, initial);
  const [disclosed, setDisclosed] = useState(false), [memory] = useState(readNoticeMemory), [closed, setClosed] = useState(memory.dismissed);
  const [notice, setNotice] = useState(null);
  const announced = useRef(false);
  const [ackFailed, setAckFailed] = useState(false);
  const model = firstRunModel(view);
  const [lineDismissed, setLineDismissed] = useState(readLineDismissed);
  const dismissLine = () => { writeLineDismissed(); setLineDismissed(true); };
  // Set synchronously, so a callback that runs between the click and the effect cleanup sees the dismissal.
  const dismissed = useRef(false);
  const dismissNotice = () => { dismissed.current = true; writeNoticeDismissed(); setClosed(true); };
  // The observer's latest intersection, shared with the Retry button so it can
  // re-check the same on-screen state at click time.
  const intersecting = useRef(false);
  // Latched synchronously before a notice POST is dispatched, so a second click
  // or observer callback cannot duplicate it while one is in flight.
  const ackBusy = useRef(false);
  // The notice's current on-screen state, read at the moment of the check: the
  // notice must be intersecting, actually on screen, in a visible tab and
  // undismissed. An observer entry can predate a layout change, so geometry is
  // read fresh here rather than trusted from the entry.
  const noticeOnScreen = () => {
    if (!notice || dismissed.current || !notice.isConnected) return false;
    if (document.visibilityState !== 'visible' || !intersecting.current) return false;
    const rect = notice.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  };
  // One ordinary notice POST. The store owns the result: only the confirmed
  // server response commits a new view, so a failure leaves the visible
  // effective state untouched and the notice stays open with a Retry.
  const acknowledge = async () => {
    if (!api || ackBusy.current || !noticeOnScreen()) return;
    ackBusy.current = true; // latch synchronously before dispatch
    announced.current = true;
    setDisclosed(true);
    setAckFailed(false);
    try { await telemetryStore.post(api, 'telemetry/notice'); }
    catch { ackBusy.current = false; setAckFailed(true); }
  };
  useEffect(() => {
    if (!model.show || !model.recordsNotice || !api || !notice || closed || !memory.durable || announced.current) return undefined;
    // Fail closed: without an observer nothing can show that the notice was seen, so nothing is acknowledged.
    if (typeof IntersectionObserver !== 'function') return undefined;
    let mounted = true;
    const onVisibility = () => {
      intersecting.current = false;
      if (document.visibilityState === 'visible') { observer.unobserve(notice); observer.observe(notice); }
    };
    const observer = new IntersectionObserver(entries => {
      if (!mounted) return;
      intersecting.current = entries.at(-1)?.isIntersecting === true;
      if (!announced.current) void acknowledge();
    });
    document.addEventListener('visibilitychange', onVisibility);
    observer.observe(notice);
    return () => {
      mounted = false;
      intersecting.current = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [model.show, model.recordsNotice, api, notice, closed]);
  if (model.show && model.unavailable) return lineDismissed ? null : <p class="telemetry-card first-run-line t-sm t-2 ph-no-capture" data-telemetry-private="telemetry-ui" role="status">
    {model.unavailable} <a href={PREVIEW_HREF}>{model.preview}</a> · {model.where}{' '}
    <button type="button" class="btn btn-quiet btn-sm" onClick={dismissLine}>Dismiss</button></p>;
  if (closed || (!model.show && !(disclosed && view?.level === null && view?.reason?.kind === 'default'))) return null;
  return <aside ref={setNotice} class="telemetry-notice ph-no-capture" data-telemetry-private="telemetry-ui" role="status" aria-label="Usage reports">
    <p class="t-sm">{model.body} <a href={model.linkHref} onClick={dismissNotice}>{model.link}</a></p>
    {ackFailed && <p class="t-sm telemetry-error" role="alert">{NOTICE_ACK_FAILED}</p>}
    {ackFailed && <button type="button" class="btn btn-secondary btn-sm" onClick={acknowledge}>Retry</button>}
    <button type="button" class="telemetry-notice-close" aria-label={model.close} onClick={dismissNotice}><span aria-hidden="true">×</span></button>
  </aside>;
}

const download = item => {
  const url = URL.createObjectURL(new Blob([item.body], {type: 'application/json'}));
  const link = Object.assign(document.createElement('a'), {href: url, download: item.filename});
  link.className = 'ph-no-capture'; link.dataset.telemetryPrivate = 'telemetry-ui-download';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

function PreviewItem({item}) {
  const [note, setNote] = useState('');
  return <li class="telemetry-item stack-2">
    <p class="t-sm"><b>{item.streamLabel}</b> · {item.stateLabel} · <time dateTime={item.at}>{item.time}</time> · {item.size} · {item.status === null ? item.statusLabel : 'status ' + item.statusLabel}</p>
    <pre class="telemetry-body" tabIndex="0" aria-label={'Exact body: ' + item.line}>{item.body}</pre>
    <div class="hstack-2 wrap">
      <button type="button" class="btn btn-secondary btn-sm" onClick={async () => {
        try { await navigator.clipboard.writeText(item.body); setNote('Copied.'); } catch { setNote('Copy was blocked by the browser. Use Download instead.'); }
      }}>Copy</button>
      <button type="button" class="btn btn-secondary btn-sm" onClick={() => { try { download(item); setNote(''); } catch { setNote('Download was blocked by the browser. Use Copy instead.'); } }}>Download</button>
      <span class="t-xs t-2" role="status">{note}</span>
    </div>
  </li>;
}

/** The page model rendered. `output` is a ready GET /api/telemetry/preview answer (tests); otherwise the page reads it. */
export function TelemetryPreview({api, output: initial = null}) {
  const [output, setOutput] = useState(initial), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initial || !api) return undefined;
    const controller = new AbortController();
    setError('');
    api.get('telemetry/preview', controller.signal).then(value => {
      if (!controller.signal.aborted) { setOutput(value); setError(''); }
    }, failure => { if (!controller.signal.aborted) setError(failure?.message || 'This could not load. Try again.'); });
    return () => controller.abort();
  }, [api, attempt]);
  const model = output ? previewModel(output) : null;
  return <div class="info-page telemetry-preview ph-no-capture" data-telemetry-private="telemetry-ui">
    <a class="back-link" href="#/you/data"><Icon name="chev-l" size="sm" />Your data</a>
    <h1 class="t-page" tabIndex="-1">{TELEMETRY_COPY.settings.links.preview}</h1>
    {error && <div><p role="alert">{error}</p><button type="button" class="btn btn-secondary" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</button></div>}
    {!model && !error && <p class="t-sm t-2" role="status">Loading…</p>}
    {model && <div class="stack-4">
      <p>{model.sentence}</p>
      <p class="t-sm t-2">{model.queuedLine}</p>
      {model.emptyLine && <p class="t-sm">{model.emptyLine}</p>}
      <ul class="stack-4 telemetry-items">{model.items.map(item => <PreviewItem key={item.key} item={item} />)}</ul>
    </div>}
  </div>;
}
