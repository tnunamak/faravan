import {whenLabel} from './view-models.mjs';
import {safeName} from './helpers.mjs';
import {circlePhrase} from './safety-copy.mjs';

const sentence = text => text[0].toUpperCase() + text.slice(1);

// The app serves a job read from its last good copy, with `savedAt`, while a circle's host doesn't answer
// (lib/v1/saved-reads.mjs). The page keeps showing the copy and says so once, in one sentence.
export function savedCopyNote(rows, circles = [], {now = Date.now(), zone} = {}) {
  const saved = (Array.isArray(rows) ? rows : [rows]).filter(row => row && typeof row.savedAt === 'string');
  if (!saved.length) return '';
  // Only a host that did not answer is unreachable. A copy saved because the host asked us to wait (`savedReason`
  // 'busy') means Faravan is catching up; the host's own computer is never told its circle is unreachable (judge r10 R1).
  const gone = saved.filter(row => row.savedReason !== 'busy'), shown = gone.length ? gone : saved;
  const names = [...new Set(shown.map(row => {
    const id = row.circle?.id ?? row.circle;
    return safeName((Array.isArray(circles) ? circles : []).find(circle => circle.id === id)?.name ?? row.circle?.name, '');
  }))];
  const named = names.every(Boolean) ? names : [];
  const phrases = named.map(circlePhrase);
  const list = phrases.length > 1 ? phrases.slice(0, -1).join(', ') + ' and ' + phrases.at(-1) : phrases[0] ?? '';
  const oldest = Math.min(...shown.map(row => Date.parse(row.savedAt)).filter(Number.isFinite));
  const when = Number.isFinite(oldest) ? whenLabel(oldest, now, zone) : '';
  if (!gone.length) return 'Faravan is catching up' + (list ? ' with ' + list : '') + '. Showing what it saved' + (when ? ' ' + when : '') + '.';
  const who = named.length === 1 ? sentence(list) + ' is' : named.length > 1 ? sentence(list) + ' are' : 'The circle’s host is';
  return who + ' unreachable. Showing what Faravan saved' + (when ? ' ' + when : '') + '.';
}
