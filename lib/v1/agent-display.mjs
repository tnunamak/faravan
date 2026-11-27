// Use product names in copy.
const NAMES = {'claude-code-subscription':'Claude Code','claude-code-api-key':'Claude Code',codex:'Codex',gemini:'Gemini CLI','gh-cli':'GitHub CLI',opencode:'OpenCode'};
export const agentDisplayName = id => typeof id === 'string' && Object.hasOwn(NAMES, id) ? NAMES[id] : 'Agent';
export const agentDisplayText = value => String(value ?? '').replace(/\S+/g, token => {
  // Only a whole prose token, optionally wrapped in quotes/parentheses and
  // followed by a comma or terminal period. Paths and identifiers stay intact.
  const match = /^(["'(]*)(.*?)([)"',]*\.?[)"',]*)$/.exec(token);
  return match && Object.hasOwn(NAMES, match[2])
    ? match[1] + NAMES[match[2]] + match[3]
    : token;
});
