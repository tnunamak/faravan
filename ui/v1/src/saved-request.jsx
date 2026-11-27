import {useState} from 'preact/hooks';
import {Button} from './ds/index.mjs';

export function SavedRequestPreview({text, circle, children}) {
  const [expanded, setExpanded] = useState(false);
  const clipped = text.length > 280;
  return <section class="card-pad stack-3 ph-no-capture" aria-label="Saved request" data-telemetry-private="saved-request">
    <h2 class="t-title3">Saved request</h2>
    <p class="t-sm">Circle: {circle || 'No circle selected'}</p>
    <p data-saved-request-text style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{clipped && !expanded ? text.slice(0,280) + '…' : text || 'No request text.'}</p>
    {clipped && <Button kind="quiet" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show full request'}</Button>}
    <div class="hstack-2 wrap">{children}</div>
  </section>;
}
