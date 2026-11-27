import {Icon} from './ds/index.mjs';

// Accepts checkLineVM's output so every surface uses the same copy and caption.
export function CheckLine({vm}) {
  return <div class={('fact ' + vm.tone) + ' ph-no-capture'} role="listitem" data-telemetry-private="check-line">
    <Icon name="terminal" size="sm" />
    <div class="grow stack-1">
      {vm.skipped ? <><div class="t-sm">Didn't run: {vm.skippedReason}</div><p class="t-xs t-2">Requested: <code>{vm.cmd}</code></p></> : <div class="t-sm">{vm.prefix}<code>{vm.cmd}</code>{vm.suffix}</div>}
      <p class="t-xs t-2">{vm.note}</p>
      {vm.changedTests.length > 0 && <p class="t-xs t-2">The agent changed test files: {vm.changedTests.join(', ')}.</p>}
    </div>
  </div>;
}

export function CheckLines({checks}) {
  return <div class="facts ph-no-capture" role="list" aria-label="Check observations" data-telemetry-private="check-line">{checks.map(vm => <CheckLine vm={vm} />)}</div>;
}
