// The "Faravan is updating" banner. The app sends `update` {state:'restarting'} over the event stream just before it
// closes; the banner stays until a stream to the new app opens. A normal restart is shorter than the connection
// grace time, so the stream never reports `false` first: the next successful connection is the signal.
export function restartBanner(setBanner, onConnection = () => {}) {
  let shown = false;
  return {
    onEvent(event) {
      if (event?.type !== 'update' || event.data?.state !== 'restarting') return;
      shown = true;
      setBanner({...event.data});
    },
    onConnection(value) {
      onConnection(value);
      if (value && shown) { shown = false; setBanner(null); }
    },
  };
}
