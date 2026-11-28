/**
 * What Faravan knows about each provider's usage endpoint, as data (plan R7, R9, R10). The host reader
 * (usage-host-reader.mjs) has no provider branch: it takes one record. Records are code, shipped and frozen. They are
 * not user-editable and not downloaded. A record never enables lending by itself: funding and identity rules stay per
 * provider in lending-readiness.mjs. Parsers stay code (lending-meter.mjs); a record names one by `parser`.
 *
 * `hosts` is the allow-list of HTTPS hosts a bearer may be sent to. The reader follows no redirect while it holds one.
 */
const WINDOW_KEYS = Object.freeze(['used_percent', 'limit_window_seconds', 'reset_at', 'reset_after_seconds']);
const deep = value => Object.freeze(Array.isArray(value) ? value.map(deep) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) : value);

export const PROVIDER_RECORDS = deep({
  claude: {
    parser: 'claude',
    hosts: ['api.anthropic.com'],
    usage: {url: 'https://api.anthropic.com/api/oauth/usage', headers: {'anthropic-beta': 'oauth-2025-04-20'},
      keep: {five_hour: ['utilization', 'resets_at'], seven_day: ['utilization', 'resets_at'], seven_day_opus: ['utilization', 'resets_at'],
        seven_day_sonnet: ['utilization', 'resets_at'], seven_day_oauth_apps: ['utilization', 'resets_at'], extra_usage: ['is_enabled'],
        limits: ['kind', 'percent', 'resets_at']}},
    // The account's own profile. Only hashes of its identifiers leave the reader. Read on a rebind only, never per cycle.
    identity: {url: 'https://api.anthropic.com/api/oauth/profile', headers: {'Content-Type': 'application/json'}},
    // Credential kinds that have a subscription usage endpoint, and the funding kind each proves (D3). An API key has none.
    subscriptionKinds: ['oauth', 'setup-token'],
    // The refresh_token grant (usage-token-refresh.mjs). Read from the installed CLI's own OAuth configuration; the exact body
    // format is not probe-verified (plan assumption 2). Unlike the Codex CLI, no environment override of the URL is honoured.
    refresh: {url: 'https://platform.claude.com/v1/oauth/token', clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', hosts: ['platform.claude.com']},
    windowKeys: WINDOW_KEYS,
  },
  codex: {
    parser: 'codex',
    hosts: ['chatgpt.com'],
    // Exactly the header set proven in the Codex Phase 0 probe.
    usage: {url: 'https://chatgpt.com/backend-api/wham/usage', headers: {originator: 'Codex Desktop', 'User-Agent': 'codex-tui/0.163.0'},
      keep: {rate_limit: ['allowed', 'limit_reached', 'primary_window', 'secondary_window'], credits: ['has_credits'],
        spend_control: ['reached'], plan_type: true}},
    identity: null,
    subscriptionKinds: ['oauth'],
    refresh: {url: 'https://auth.openai.com/oauth/token', clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', hosts: ['auth.openai.com']},
    windowKeys: WINDOW_KEYS,
  },
});
