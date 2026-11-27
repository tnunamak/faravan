/** Instructions about result delivery, separate from the person's request. */
export const JOB_FRAMING_VERSION = 1;
// Message and files jobs return only this folder (relative to the workspace) as attachments.
export const OUTPUT_DIR = 'faravan-output';
export function jobFraming(workspace, result) {
  if (result === undefined || result === 'branch')
    return `You work in ${workspace}. Only changes to files in this folder come back to the person. Save any files you create (images, reports, data) inside this folder, for example under faravan-output/ (older agents may use faravan-output/), never in /tmp or your home. The person reviews the changes before using them. If you need an answer, end your final message with a separate QUESTION: line.`;
  const output = `${workspace}/${OUTPUT_DIR}/`;
  if (result === 'message')
    return `You work in ${workspace}. The person wants your answer, not code changes. Your final message is what they read, so make it complete and write it in Markdown. Save any files they should get (images, data, documents) in ${output}, never in /tmp or your home. Only your final message and the files in ${OUTPUT_DIR}/ or faravan-output/ come back to the person. For questions, end with QUESTION: on its own line.`;
  if (result === 'files')
    return `You work in ${workspace}. The person asked for files, not code changes. Save every file you produce in ${output}, never in /tmp or your home. Only files in ${OUTPUT_DIR}/ or faravan-output/ come back to the person. For questions, end with QUESTION: on its own line.`;
  throw new Error('Unknown job result: ' + result);
}
export const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export function promptCommand(entrypoint, {prompt, workspace, args = [], result}, mechanism = 'prompt') {
  const framing = jobFraming(workspace, result);
  const options = mechanism === 'claude' ? ['--append-system-prompt', framing] :
    mechanism === 'codex' ? ['-c', 'developer_instructions=' + JSON.stringify(framing)] : [];
  const request = mechanism === 'prompt' ? framing + '\n\n' + prompt : prompt;
  return [entrypoint, ...args.map(shellQuote), ...options.map(shellQuote), shellQuote(request)].join(' ');
}
