// The view models return one of these kinds (view-models.mjs); every kind has a word.
export const STATUS_WORDS = {on: 'On', off: 'Off', wait: 'Waiting', bad: 'Failed', need: 'Waiting for you', run: 'Running'};

export function Status({kind = 'off', word}) {
  return (
    <span class={'pill ' + kind}>
      <span class="dot" aria-hidden="true" />
      {word || STATUS_WORDS[kind]}
    </span>
  );
}

// Compact form for phone rows: dot and word, no pill.
export function InlineStatus({kind = 'off', word}) {
  return <span class={'st ' + kind}>{word || STATUS_WORDS[kind]}</span>;
}
