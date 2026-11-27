import { Action } from './shared.jsx';
import { Card, Icon } from './ds/index.mjs';

// A strip under the page head: the data on screen is old, or live updates are paused.
export function ConnectionBanner({ vm, onRetry }) {
  if (!vm) return null;
  return (
    <div class="offline ph-no-capture" role="status" data-telemetry-private="shell-states">
      <Icon name={vm.icon} size="sm" />
      <span class="grow">{vm.text}{vm.asOf&&<span class="offline-as-of">{vm.asOf}</span>}</span>
      <div class="offline-actions">
      {vm.action && <Action className="linkish" run={vm.copy ? () => navigator.clipboard.writeText(vm.copy) : onRetry} success={vm.copy ? 'Copied. Run it in a terminal.' : ''} allowOffline>{vm.action}</Action>}
      {vm.details && <Action className="linkish" run={() => navigator.clipboard.writeText(vm.details)} success="Details copied." allowOffline>Copy details</Action>}
      </div>
    </div>
  );
}

// "A new version is ready": a toast with one button. It never reloads by itself.
export function UpdateToast({ vm, onOpenUpdates }) {
  if (!vm) return null;
  return (
    <div class="toast-wrap ph-no-capture" data-telemetry-private="shell-states">
      <div class="toast" role="status">
        <Icon name={vm.icon} />
        <span class="grow">{vm.text}</span>
        {vm.action && <button type="button" class="btn btn-secondary" onClick={vm.actionKind === 'updates' ? onOpenUpdates : () => location.reload()}>{vm.action}</button>}
      </div>
    </div>
  );
}

// What a page shows before its first read arrives: the shape of the page, not a spinner.
export function PageSkeleton({ label = 'Loading' }) {
  const lines = (a, b) => <><div class="skel ph-no-capture" style={{ width: a }} data-telemetry-private="shell-states" /><div class="skel ph-no-capture" style={{ width: b }} data-telemetry-private="shell-states" /></>;
  return (
    <div class="stack-6 ph-no-capture" role="status" aria-label={label} data-telemetry-private="shell-states">
      <Card><div class="card-pad stack-3">{lines('50%', '30%')}<div class="skel" /><div class="skel" style={{ width: '80%' }} /></div></Card>
      <Card>
        {[1, 2, 3].map((n) => (
          <div class="row" key={n}>
            <span class="av" style={{ '--c': '#999' }} />
            <div class="grow stack-2">{lines('60%', '35%')}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}
