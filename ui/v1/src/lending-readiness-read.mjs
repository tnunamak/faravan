import {useEffect, useRef, useState} from 'preact/hooks';

/**
 * Planning evidence belongs to one render identity. Physical GET ownership is
 * separate: timeout/disposal request abort, but only settlement frees its slot.
 */
export function useLendingReadiness(api, readiness, agents, initial = null) {
  const [attempt, setAttempt] = useState(0);
  const identity = useRef(null);
  if (!identity.current || identity.current.api !== api ||
      identity.current.readiness !== readiness || identity.current.agents !== agents ||
      identity.current.attempt !== attempt) {
    identity.current = {api, readiness, agents, attempt};
  }
  const current = identity.current;
  const [reading, setReading] = useState(() => ({identity: current, value: initial, error: false}));
  const physical = useRef(new Map());
  const wanted = useRef(null);

  useEffect(() => {
    const request = {identity: current, active: true, started: false, observed: true, flight: null};
    wanted.current = request;
    const live = () => request.active && wanted.current === request && identity.current === current;
    const publish = (value, error) => {
      if (live() && request.observed) setReading({identity: current, value, error});
    };
    request.reportDeadline = flight => {
      publish(null, true);
      if (request.flight === flight) request.observed = false;
    };
    const start = () => {
      if (!live() || request.started || typeof api?.get !== 'function' || physical.current.has(api)) return;
      request.started = true;
      setReading({identity: current, value: null, error: false});
      const controller = new AbortController();
      const flight = {controller, timedOut: false, timer: null};
      request.flight = flight;
      physical.current.set(api, flight);
      // Schedule invocation in a promise so synchronous throws settle ownership too.
      Promise.resolve().then(() => {
        if (!live()) return;
        flight.timer = setTimeout(() => {
          flight.timedOut = true;
          if (wanted.current?.identity.api === api) wanted.current.reportDeadline(flight);
          controller.abort();
        }, 15000);
        return api.get('lending/readiness', controller.signal);
      }).then(
        value => publish(value, false),
        () => publish(null, true),
      ).finally(() => {
        clearTimeout(flight.timer);
        if (physical.current.get(api) === flight) physical.current.delete(api);
        // A late result cannot publish for a newer identity, but real settlement
        // permits its latest still-live effect to acquire this API's vacant slot.
        wanted.current?.start();
      });
    };
    request.start = start;
    if (typeof api?.get === 'function') {
      // An abort-ignoring transport still owns the slot. Keep retry available
      // until it settles instead of replacing the error with an endless spinner.
      if (physical.current.get(api)?.timedOut) setReading({identity: current, value: null, error: true});
      start();
    }
    return () => {
      request.active = false;
      request.observed = false;
      if (wanted.current === request) wanted.current = null;
    };
  }, [current]);
  // A background refresh retires evidence but keeps the transport slot until
  // settlement. Explicit Retry, API replacement and unmount still cancel it.
  useEffect(() => () => {
    const flight = physical.current.get(api);
    if (!flight) return;
    clearTimeout(flight.timer);
    flight.controller.abort();
  }, [api, attempt]);

  return {
    value: reading.identity === current ? reading.value : null,
    error: reading.identity === current && reading.error,
    retry: () => setAttempt(value => value + 1),
  };
}
