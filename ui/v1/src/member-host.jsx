import {displayVisible, visibleInterval} from './display-visibility.mjs';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './ds/index.mjs';
import { memberHostVM } from './view-models.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';
import {formatDayTime} from './dates.mjs';

export function memberHostObservation(previous, value, error, checkedAt = Date.now()) {
  return error ? {...previous, error: true, failedAt: checkedAt} : {value, error: false, checkedAt};
}
export function memberHostBanners(observation, options) {
  const known = memberHostVM(observation?.value, options);
  if (!observation?.error) return known;
  return [{id: 'host-unknown', tone: 'wait', icon: 'laptop', headline: 'Can’t check the host right now. Its status is unknown.', text: ''},
    ...known.map(({href, linkLabel, ...banner}) => ({...banner, stale: true, headline: 'Last known status. ' + banner.headline}))];
}

const enc = encodeURIComponent;

// Every circle owns its read deadline and generation; one peer cannot hold another's result.
export function pollMemberHosts(api, ids, onResult) {
    let stop = false;
    const epochs = new Map(), flights = new Map();
    let active = new Set(ids);
    const load = (selected = active) => {
      if (stop) return;
      for (const id of selected) {
        // Deadline expiry does not prove the returned transport promise ended.
        if (!active.has(id) || flights.has(id)) continue;
        const generation = (epochs.get(id) || 0) + 1;epochs.set(id, generation);
        const controller = new AbortController();
        let settled = false;
        const cancel = () => {if (!controller.signal.aborted) controller.abort();};
        const commit = (value, error) => {
          if (settled) return;settled = true;clearTimeout(timeout);
          if (stop || !active.has(id) || epochs.get(id) !== generation) return;
          onResult(id, value, error, Date.now());
        };
        const timeout = setTimeout(() => {cancel();commit(undefined, true);}, 15000);
        const flight = {dispose() {settled = true;clearTimeout(timeout);cancel();}};
        flights.set(id, flight);
        const complete = (value, error) => {
          if (flights.get(id) === flight) flights.delete(id);
          commit(value, error);
        };
        Promise.resolve().then(() => {
          if (stop || settled || !active.has(id)) return undefined;
          return api.get('circles/' + enc(id) + '/compose', controller.signal);
        }).then(value => complete(value, false), () => complete(undefined, true));
      }
    };
    const schedule = () => visibleInterval(() => load(), 20000);
    let stopPolling = active.size ? schedule() : null;
    const dispose = () => {
      if (stop) return;
      stop = true;stopPolling?.();
      for (const flight of flights.values()) flight.dispose();
    };
    // Reconciliation retires publication, not physical ownership. A removed or
    // timed-out request still occupies its slot until its returned promise ends.
    dispose.reconcile = nextIds => {
      if (stop) return;
      const next = new Set(nextIds), added = [...next].filter(id => !active.has(id));
      for (const id of active) if (!next.has(id)) {
        epochs.set(id, (epochs.get(id) || 0) + 1);
        flights.get(id)?.dispose();
      }
      active = next;
      if (!active.size) {stopPolling?.();stopPolling = null;}
      else if (!stopPolling) stopPolling = schedule();
      else if (displayVisible()) load(added);
    };
    dispose.refresh = () => load();
    return dispose;
}

// What a member sees about a host that does not answer (H3). The circle's own state is asked for every 20 seconds
// while a page that shows it is open; a circle this computer hosts, or one with no server, is never asked.
export function useMemberHost(api, circles) {
  const apiOwner = useMemo(() => ({}), [api]);
  const [snapshot, setSnapshot] = useState(null);
  const current = snapshot?.owner === apiOwner ? snapshot : null;
  const ids = circles.filter((c) => c.origin && c.owned !== true && membershipProjectionFor(c).phase === 'approved').map((c) => c.id);
  const key = JSON.stringify(ids);
  const owner = useRef(null);
  const retry = () => owner.current?.refresh();
  // A poller lives for the API lifetime, not for a retry or a changing roster.
  // Its retained physical slots therefore survive both of those operations.
  useEffect(() => {
    const poller = pollMemberHosts(api, [], (id, value, error, checkedAt) => {
      setSnapshot(old => {
        const states = old?.owner === apiOwner ? old.states : {};
        return {owner: apiOwner, now: checkedAt,
          states: {...states, [id]: memberHostObservation(states[id], value, error, checkedAt)}};
      });
    });
    owner.current = poller;
    return () => {if (owner.current === poller) owner.current = null;poller();};
  }, [api, apiOwner]);
  useEffect(() => {
    setSnapshot(old => old?.owner === apiOwner
      ? {...old, states: Object.fromEntries(ids.map(id => [id, old.states[id]]))}
      : old);
    owner.current?.reconcile(ids);
  }, [key, apiOwner]);
  if (!current) return [];
  return ids.map(id => {
    const observation = current.states[id];
    return {circle: circles.find(c => c.id === id), retry, checkedAt: observation?.checkedAt,
      unknown: observation?.error, banners: memberHostBanners(observation, {now: current.now})};
  }).filter(item => item.banners.length);
}

export function MemberHostNotices({ items, link = false }) {
  return items.map(({ circle, banners, retry, checkedAt, unknown }) => (
    <div class="stack-3 member-host ph-no-capture" key={circle.id} data-telemetry-private="member-host">
      {unknown && <div>{checkedAt && <p class="t-sm">Last known status checked {formatDayTime(checkedAt)}.</p>}<button type="button" class="btn btn-secondary" onClick={retry} aria-label={'Check all host statuses; ' + (circle.name || 'this circle') + ' status unknown'}>Check all host statuses</button></div>}
      {banners.map((b) => (
        <div class={'banner ' + (b.tone === 'need' ? '' : b.tone)} role={b.tone === 'bad' ? 'alert' : 'status'} id={b.id + '-' + circle.id}>
          <Icon name={b.icon} />
          <div class="grow"><b>{b.id === 'host-unknown' ? (circle.name || 'This circle') + ': ' : ''}{b.headline}</b><p class="t-sm">{b.text}</p>{!unknown && !b.stale && b.href && <p class="t-sm"><a href={b.href}>{b.linkLabel}</a></p>}{link && !unknown && !b.stale && b.id === 'host-offline' && <p class="t-sm"><a href={'#/circle/' + enc(circle.id)}>See {circle.name}</a></p>}</div>
        </div>
      ))}
    </div>
  ));
}
