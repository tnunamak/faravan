Lending meter fixtures.

- claude-budget-stream.jsonl: the `rate_limit_event` and `result` lines are verbatim from the redacted Phase 0
  capture (briefs/../phase0-evidence/budget-stream.json, 2026-10-20, Claude Code 2.1.280). The `assistant` lines are
  SYNTHETIC: four calls whose token sums equal the live result's `modelUsage`, each repeated as two content blocks.
- codex-rollout.jsonl: SYNTHETIC lines in Codex 0.149 rollout shape. Rate-limit values are the live Phase 0 reading.
- *-usage-body.json: SYNTHETIC bodies in the live response shape (Phase 0 recorded field names/types only).
  Window values are the live Phase 0 readings. Identifier fields hold fake values the parsers must drop.
- codex-median-week.json: the median-ranked complete UTC calendar week (upper middle of 36) from the
  real-owner hourly Codex aggregate, snapshot 2026-10-26. The compressed input SHA-256 is in the fixture.
  Rates are labelled “Codex ratio of sums, 8 weeks”. This is recorded USD multiplied by a measured
  conversion, not a complete quota-meter trace; the source has zero complete weekly meter traces.
