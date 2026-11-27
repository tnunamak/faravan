// `faravan open-link <url>`: the target of the faravan:// scheme handler (faravan:// remains supported). It opens the local app at the
// join review screen with the invitation filled in. It never joins; the person still confirms in the app.
import * as p from '../protocol/index.mjs';
import { classifyJoinInput } from './short-invite.mjs';
import { UsageError } from './cli.mjs';
import { openUrl as defaultOpenUrl } from './open-url.mjs';

/** The part of the local app URL that carries the invitation. The app removes it on load (join-prefill.mjs). */
export const JOIN_PREFILL_PREFIX = '#/circles?join=';

/** Accepts faravan://join?link=<link>, or a short/long invitation link directly. Returns the plain link. */
export function invitationFromOpenLinkArgument(argument) {
  let kind, link;
  try { ({ kind, link } = classifyJoinInput(argument)); } catch { throw new UsageError('That is not a Faravan invitation link.'); }
  // Structure only: the app does the network check and shows the review. Obvious junk never reaches the browser.
  const wellFormed = kind === 'short' ? p.decodeShortLink(link).ok : p.decodeInviteLink(link).ok;
  if (!wellFormed) throw new UsageError('That is not a valid Faravan invitation link.');
  return link;
}

/** handoffUrl is a one-time sign-in link (handoff-link.mjs). The invitation goes in its fragment; the code is spent once. */
export function appUrlForInvitation(handoffUrl, link) {
  const url = new URL(handoffUrl);
  if (url.hostname !== '127.0.0.1') throw new UsageError('The local app address is not loopback.');
  url.hash = JOIN_PREFILL_PREFIX + encodeURIComponent(link);
  return url.toString();
}

export async function runOpenLink(argv, { ensureHandoff, openUrl = defaultOpenUrl, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv.length !== 1 || argv[0].startsWith('--')) throw new UsageError('Usage: faravan open-link <faravan://join?link=...>');
    const link = invitationFromOpenLinkArgument(argv[0]);
    const target = appUrlForInvitation(await ensureHandoff(), link);
    openUrl(target);
    stdout.write('Opened Faravan to review the invitation. Nothing is joined until you confirm.\n');
    return 0;
  } catch (error) {
    stderr.write('faravan: ' + (error instanceof UsageError ? error.message : 'Could not open the invitation in Faravan.') + '\n');
    return error instanceof UsageError ? 2 : 1;
  }
}
