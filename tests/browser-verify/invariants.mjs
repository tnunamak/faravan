import {renderedSnapshot} from './invariants-dom.mjs';
import {problemView} from '../../ui/v1/src/problem-catalog.mjs';

// Rules operate on Chromium's visible output. Context comes from a journey's
// real actions/responses, never inferred from the copy being checked.
const rule=(id,title,check)=>({id,title,check});
const BUSY_REFUSAL=(view=>[view.title,view.detail].filter(Boolean))(problemView({code:'rate_limited'}));
const has=(s,re)=>re.test(s.text);
const enabled=(s,re)=>s.buttons.some(b=>!b.disabled&&re.test(b.text));
export const INVARIANTS=[
  rule('I01','No raw internals',s=>has(s,/\(error\s+\d{3}\)|\bHTTP\s+[45]\d\d\b|claude-code-subscription|codex-subscription|sha256:|faravan\.continuation\.v1|Untrusted previous context|\{\s*"[\w-]+"\s*:|\bundefined\b|\[object Object\]|\breceipt\b|\/(?:home|Users|workspace|tmp)\//i)),
  rule('I02','No page horizontal overflow',s=>s.horizontalOverflow>1),
  rule('I03','No mid-word prose wraps',s=>s.brokenWords.length>0),
  rule('I04','No squeezed sentences',s=>s.squeezedText.length>0),
  rule('I05','Phone advice fits a phone',s=>s.width<=390&&has(s,/open (?:it|faravan|faravan).*from the tray|reopen the (?:local )?app|run (?:faravan|faravan)|copy command|\bgit (?:apply|switch|init)\b|\$\s+(?:git|faravan|faravan)\b/i)),
  rule('I06','Fresh reads do not claim stale status',(s,c)=>((c.jobFresh??c.fresh)&&has(s,/Last known:|Job status is updating/i))||((c.appFresh??c.fresh)&&has(s,/Live updates paused|Status needs an update|Faravan is unreachable/i))),
  rule('I07','Approval agrees with execution',s=>(s.statusGroups??[s.text]).some(text=>/Approved|said yes|Ready to review|Result delivered|Sent back|Agent working|Agent is working/i.test(text)&&/Waiting for (?:a decision|an answer|approval|.+ to say yes)/i.test(text))),
  rule('I08','Capped lenders cannot accept',(s,c)=>((c.capped||has(s,/Done for today|daily (?:job |minute )?limit (?:reached|used)/i))&&(enabled(s,/^Run it$/)||has(s,/Ready for requests/i)))||(c.requestDoesNotFit&&enabled(s,/^Run it$/))),
  rule('I09','Blocked lending is not ready',s=>has(s,/No job can start|Waiting for the safety test|No agent is chosen/i)&&has(s,/Ready for requests|is ready to lend|Lending is on/i)),
  rule('I10','Skipped checks do not claim execution',s=>has(s,/Didn't run|didn’t run|check (?:was skipped|did not run)/i)&&has(s,/(?:Faravan|Faravan) ran .+ after the agent/i)),
  rule('I11','Known people lead identity copy',(s,c)=>(c.people??[]).some(({device,person})=>device!==person&&has(s,new RegExp(escapeRE(device)+"(?:[’']s agent| wants to run| asked for help| to stop| · Member)|(?:Sent to|Job for) "+escapeRE(device),'i')))),
  rule('I12','Own computer is not third person',(s,c)=>c.selfDevice&&has(s,new RegExp(escapeRE(c.selfDevice)+"[’']s (?:agent|computer)",'i'))),
  rule('I13','No transcript filler or bare tool rows',s=>has(s,/\[private details withheld\]/i)||s.bareTools?.length>0),
  rule('I14','Accepted prompt remains available',(s,c)=>c.promptKnown&&has(s,/prompt is not available|request couldn.t be loaded|prompt couldn.t be loaded/i)),
  rule('I15','Own accept never says answered elsewhere',(s,c)=>c.accepting&&has(s,/answered somewhere else/i)),
  rule('I16','Joined circle is not pending',(s,c)=>c.joined&&has(s,/not in the circle yet|Waiting for approval|Waiting for .+ to approve/i)),
  rule('I17','Plain folders have a usable result action',(s,c)=>c.plainFolderResult&&(enabled(s,/Add as a branch/ )||!enabled(s,/Download (?:changed|all) files|Save to a new folder|Copy into a new folder/))),
  rule('I18','Message results keep message framing',(s,c)=>c.messageResult&&has(s,/What changed for you|0 files changed|Use these changes|The agent made no changes/i)),
  rule('I19','Agent markdown is rendered',s=>s.rawMarkdown?.length>0),
  rule('I20','Message line breaks are preserved',(s,c)=>c.expectedLines?.length>1&&(!s.lineGroups?.length||s.lineGroups.some(group=>c.expectedLines.some((line,index)=>index>0&&!(group[line]>group[c.expectedLines[index-1]]))))),
  rule('I21','Diff characters have no ligatures',s=>s.codeLigatures.length>0),
  rule('I22','Phone diff has no persistent note glyphs',s=>s.width<=390&&s.persistentNoteButtons>0),
  rule('I23','Screen-reader announcements stay hidden',s=>s.visibleLiveAnnouncements.length>0),
  rule('I24','Saved confirmation does not float over fields',s=>s.floatingSaved.length>0),
  rule('I25','Result stays inside the page frame',s=>s.frameOverflow.length>0),
  rule('I26','Phone decision precedes long diff',s=>s.width<=390&&s.primaryTop!==null&&s.diffTop!==null&&s.primaryTop>s.diffTop),
  rule('I27','Offer deadlines name the day',(s,c)=>c.deadlineFutureDay&&has(s,/Open until/i)&&!has(s,/Open until (?:today|tomorrow|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|\w+ \d)/i)),
  rule('I28','Expired offers cannot run',(s,c)=>c.expiredOffer&&enabled(s,/^Run it$/)),
  rule('I29','Live output reaches both computers in five seconds',(s,c)=>c.liveMarker&&(!s.text.includes(c.liveMarker)||c.liveLatencyMs>5000)),
  rule('I30','API reads stay within page minute budget',(s,c)=>c.network&&(c.network.reads>120||c.network.maxPerPath>68||c.network.maxConcurrent>1||c.network.aborted>0)),
  rule('I31','Available pages finish loading',(s,c)=>(s.loadingLabels??[]).some(label=>c.availableResources?.[label]>=10000)||(c.dataAvailable&&c.stateAgeMs>=10000&&has(s,/Loading (?:job|result|changes)|The job didn.t load|Result unavailable/i))),
  rule('I32','Cached result survives host outage',(s,c)=>c.cachedResult&&(!s.text.includes(c.resultMarker)||has(s,/The job didn.t load|Jobs didn.t load|Result unavailable/i))),
  rule('I33','Mutation confirms on the open page',(s,c)=>c.mutation&&c.mutation.ageMs>=2000&&!new RegExp(c.mutation.confirmation,'i').test(s.text)),
  rule('I34','Own jobs do not count as helping others',(s,c)=>c.onlyOwnJobs&&has(s,/You helped [1-9]|the lender.s .+ time/i)),
  rule('I35','Missing sandbox names the terminal step',(s,c)=>c.missingSandbox&&!has(s,/terminal/i)),
  rule('I36','Fresh result does not show generic failure',(s,c)=>c.resultAvailable&&has(s,/Result unavailable|Faravan couldn.t complete this action\. Try again/i)),
  rule('I37','Join without restart does not claim restart',(s,c)=>c.noRestart&&has(s,/did not resume after Faravan restarted/i)),
  rule('I38','Cold session error uses app typography',(s,c)=>c.expiredSession&&s.defaultSerif),
  rule('I39','Valid circle form has an in-app start',(s,c)=>c.circleFormReady&&(!enabled(s,/^Start circle$/)||Boolean(c.personName&&s.circleName===c.personName))),
  rule('I40','Plain-folder errors offer recovery',(s,c)=>c.plainFolderRejected&&(!enabled(s,/Choose|Browse|Use (?:this )?folder|No project|Try another/i)||has(s,/is a folder but not a git repository/i))),
  rule('I41','ASCII blocks preserve whitespace and monospace',s=>s.badPreformatted?.length>0),
  rule('I42','First live message is not the final summary',(s,c)=>c.firstLiveMessage&&c.finalSummary&&c.firstLiveMessage!==c.finalSummary&&s.summaryText===c.firstLiveMessage),
  // Judge r9 O-A/C/D/E: a job or lending state the person just acted on, or one this computer saved, is shown as that
  // state (marked last known or in progress), never as "unavailable".
  // Judge r10 R1: a saved copy never names an empty state ("Last known:" and nothing), and a host whose process is up
  // is never called unreachable: a busy host is catching up, and the host's own computer always reaches itself.
  rule('I43','No status-unavailable copy when a last-known or transitional state exists',(s,c)=>((c.knownState||c.accepting||c.cachedResult)&&
    has(s,/Status unavailable|status is not available|not available yet|Lending status could not be confirmed|We can.t tell what happened|Refresh the (?:job|page) to check its status/i))||
    (s.emptyLastKnown??[]).length>0||(c.hostAvailable===true&&has(s,/\bis unreachable\. Showing what Faravan saved|are unreachable\. Showing what Faravan saved/i))),
  // Judge r9 O-B, r10 R2: a person's own action never ends in a refusal while the host is merely busy. The refusal is
  // whatever the problem catalog shows for rate_limited, so new wording cannot slip past this rule.
  // Judge r10 R3, R5, R9: "ready" means an offer arriving now would be admitted. Whenever a page says a computer is
  // ready, the lending computer's real admission check must admit a test offer (3 s for the news to reach a peer).
  rule('I45','Ready means the lender would admit an offer now',(s,c)=>typeof c.readyAdmission==='string'&&c.readyAdmission!=='off'&&
    (c.readyRefusedMs??0)>=3000&&has(s,/Ready for requests|\b\d+ computers? (?:is|are) ready\b/i)),
  rule('I44','A person\'s action never ends in a busy-host refusal',(s,c)=>(c.userAction||c.mutation)&&
    (BUSY_REFUSAL.some(text=>s.text.includes(text))||has(s,/handling other requests|Wait before checking again/i))),
];
function escapeRE(text){return text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
export function invariantFailures(snapshot,context={}) {
  return INVARIANTS.filter(r=>r.check(snapshot,context)).map(({id,title})=>({id,title}));
}

export async function checkPage(page,context={},{probe=false}={}) {
  const snapshot=await renderedSnapshot(page,{lines:context.expectedLines,probe});
  return {failures:invariantFailures(snapshot,context),snapshot};
}
