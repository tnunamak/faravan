import { enc } from './shared.jsx';
import { Avatar, Icon } from './ds/index.mjs';

const href = (card) => '#/request/' + enc(card.id);

// Waiting requests as rows (Home, Lending): who, what they asked, and a link to the request page.
export function RequestRows({ rows }) {
  return (
    <ul class="list card wrapt ph-no-capture" data-telemetry-private="request-rows">
      {rows.map(({ card, view }) => (
        <li key={card.id}>
          <a class="row" href={href(card)}>
            <Avatar personName={view.localName} id={view.requesterKey} />
            <div class="row-main">
              <div class="row-title"><bdi>{view.localName || view.requesterName}</bdi>: {view.prompt.split('\n')[0].slice(0, 90)}</div>
              <div class="row-meta dots">{[view.agent, view.minutes].filter(Boolean).map((part) => <span>{part}</span>)}</div>
            </div>
            <div class="row-end"><Icon name="chev-r" size="sm" /></div>
          </a>
        </li>
      ))}
    </ul>
  );
}
