// Compatibility entrypoint. Harness data and behavior live together.
export { CODEX_HARNESS } from './harnesses/codex.adapter.mjs';
export { CODEX_LENDING_HARNESS } from './harnesses/codex.adapter.mjs';
export { CLAUDE_CODE_SUBSCRIPTION_HARNESS, CLAUDE_CODE_SUBSCRIPTION_HARNESS as CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS } from './harnesses/claude-code-subscription.adapter.mjs';
export { CLAUDE_CODE_API_KEY_HARNESS } from './harnesses/claude-code-api-key.adapter.mjs';
export { GEMINI_HARNESS } from './harnesses/gemini.adapter.mjs';
export { GH_CLI_HARNESS } from './harnesses/gh-cli.adapter.mjs';
export { OPENCODE_HARNESS } from './harnesses/opencode.adapter.mjs';
export { HARNESS_ADAPTERS, DEFAULT_IDENTITY_PROBE_HARNESSES, getHarnessAdapter } from './harnesses/index.mjs';
