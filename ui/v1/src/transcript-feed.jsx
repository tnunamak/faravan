import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { Icon } from './ds/index.mjs';
import { followVM, runningVM, toolLabel, feedFreshness, feedEvidenceLabels, feedAnnouncement } from './transcript-feed.mjs';
import {Markdown} from './result-reader.jsx';

function Time({entry}) {
  return entry.timeTitle ? <time class="feed-time ph-no-capture" title={entry.timeTitle} data-telemetry-private="transcript-feed">{entry.time}</time> : <span class="feed-time ph-no-capture" data-telemetry-private="transcript-feed" />;
}

function Message({entry}) {
  return <li class="feed-entry feed-msg ph-no-capture" data-telemetry-private="transcript-feed">{entry.role === 'user' && <span class="t-xs t-2">User message</span>}<Markdown className="agent-markdown" text={entry.text}/><Time entry={entry} /></li>;
}

function Text({entry}) {
  return <li class={('feed-entry feed-text' + (entry.error ? ' is-error' : '')) + ' ph-no-capture'} data-telemetry-private="transcript-feed">{entry.error ? <p role="note"><Icon name="alert" size="sm" />{entry.text}</p> : <Markdown className="agent-markdown" text={entry.text}/>}<Time entry={entry} /></li>;
}

function Tool({entry, now, lastAt}) {
  const running = entry.running ? runningVM(entry, {now, lastAt}) : null;
  const label = toolLabel(entry);
  const meta = !entry.completed && !entry.running ? 'Outcome not recorded' : entry.error ? 'Failed' : running ? running.timer : entry.took;
  const extra = entry.full.includes('\n') || entry.full.length > entry.target.length ? entry.full : '';
  const open = Boolean(entry.output || extra);
  const row = <>
    <span class="feed-icon ph-no-capture" data-telemetry-private="transcript-feed">{<Icon name={entry.error ? 'x-circle' : entry.icon} size="sm" />}</span>
    <span class="feed-line ph-no-capture" data-telemetry-private="transcript-feed"><span class="feed-verb">{label}</span>{entry.target && <code class="feed-target" title={entry.full}>{entry.target}</code>}</span>
    {meta && <span class="feed-meta ph-no-capture" data-telemetry-private="transcript-feed">{meta}</span>}
    {open && <Icon name="chev-r" size="sm" class="feed-chev" />}
  </>;
  const cls = 'feed-entry feed-tool' + (entry.error ? ' is-error' : '') + (entry.running ? ' is-running' : '');
  return <li class={(cls) + ' ph-no-capture'} data-telemetry-private="transcript-feed">
    {open ? <details class="feed-more"><summary class="feed-row" aria-label={label + ' ' + entry.target + (entry.error ? ', failed' : '') + (extra ? entry.output ? ', show command and output' : ', show command' : ', show output')}>{row}</summary>
      {extra && <pre class="feed-output feed-command">{extra}</pre>}
      {entry.output && <pre class="feed-output" tabIndex="0">{entry.output}</pre>}
    </details> : <div class="feed-row">{row}</div>}
    <Time entry={entry} />
    {running?.quiet && <p class="feed-quiet">{running.quiet}</p>}
  </li>;
}

function Withheld({entry}) {
  return <li class="feed-entry feed-withheld t-sm t-2 ph-no-capture" role="note" data-telemetry-private="transcript-feed">{entry.text}</li>;
}

const ENTRY = {message: Message, tool: Tool, text: Text, withheld: Withheld};

/**
 * "What the agent is doing": the transcript feed from transcriptFeedVM. While the job runs it is open and keeps to the
 * newest entry as long as the reader stays at the bottom; scrolling up stops that and offers "Jump to latest".
 */
// `now` is the job page's one-second clock, so a running step's timer ticks with it.
export function AgentActivity({feed, live, version, empty, now, unavailable,viewer,bare=false,headline,facts=[],freshness,question=false}) {
  const [open, setOpen] = useState(bare || live === true);
  const [follow, setFollow] = useState({following: live === true, jump: false});
  const pane = useRef();
  const previous = useRef();
  const [announcement, setAnnouncement] = useState({text:'', sequence:0});
  const output = JSON.stringify(feed.entries.filter(entry => entry.kind !== 'withheld').map(entry => [entry.id, entry.text, entry.output, entry.completed, entry.error]));
  useLayoutEffect(() => {
    const current = {connected: freshness?.connected, question: Boolean(question), output};
    const next = feedAnnouncement(previous.current, current);
    if (next) setAnnouncement(value => ({text:next, sequence:value.sequence+1}));
    previous.current = current;
  }, [output, question, freshness?.connected]);
  const confirmedLive = live && feedFreshness(freshness, now);
  useLayoutEffect(() => { if (open && follow.following && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [version, open, follow.following]);
  function onScroll(event) {
    const el = event.currentTarget, next = followVM({scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight}, live);
    if (next.following !== follow.following || next.jump !== follow.jump) setFollow(next);
  }
  function jump() {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
    setFollow({following: true, jump: false});
  }
  if(unavailable)return <section class="card activity ph-no-capture" data-telemetry-private="transcript-feed"><div class="activity-head"><h2 class="t-title3">What the agent is doing</h2></div><div class="activity-body"><p class="t-sm t-2 activity-empty">{viewer==='ran'?'Live activity isn’t shown for this job.':unavailable==='host_version'?'Live activity isn’t available with this host’s version.':'Live activity isn’t available from this lender’s version.'} The transcript arrives with the result.</p></div></section>;
  if(!live&&!feed.entries.length)return null;
  const Container=bare?'section':'details',Head=bare?'div':'summary';
  return <Container class={(bare?'activity activity-bare':'card activity') + ' ph-no-capture'} open={bare?undefined:open} onToggle={event => setOpen(event.currentTarget.open)} data-telemetry-private="transcript-feed">
    <Head class="activity-head">
      {!bare && <Icon name="chev-r" size="sm" class="activity-chev" />}
      <h2 class="t-title3">What the agent is doing</h2>
      {confirmedLive && <span class="activity-live"><span class="activity-dot" aria-hidden="true" />Live</span>}
    </Head>
    <div class="activity-body">
      <p class="t-sm t-2" aria-live="polite" aria-atomic="true"><span key={announcement.sequence}>{announcement.text}</span></p>
      <p class="t-xs t-2">{feedEvidenceLabels(feed, now).join(' · ')}</p>
      {/* The headline is a live claim and needs freshness; the observed start and limit are not, so they show without it. */}
      {confirmedLive && headline ? <div class="activity-intro stack-2"><b>{headline}</b>{facts.length>0&&<p class="t-sm t-2">{facts.join(' · ')}</p>}</div>
        : facts.length>0 && <div class="activity-intro stack-2"><p class="t-sm t-2">{facts.join(' · ')}</p></div>}
      {feed.entries.length ? <ol ref={pane} class="feed" tabIndex="0" aria-label="What the agent is doing" onScroll={onScroll}>
        {feed.trimmed && <li class="feed-trim">Earlier steps aren’t shown</li>}
        {feed.entries.map(entry => { const Entry = ENTRY[entry.kind]; return <Entry key={entry.id} entry={entry} now={now} lastAt={feed.lastAt} />; })}
      </ol> : <p class="t-sm t-2 activity-empty">{empty}</p>}
      {follow.jump && <button type="button" class="feed-jump" onClick={jump}>Jump to latest<Icon name="chev-d" size="sm" /></button>}
    </div>
  </Container>;
}
