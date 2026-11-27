// Import before the test preludes: they put fake sbx, systemctl and busctl shims first on PATH.
// The live probe needs the real host commands, so it restores this PATH inside the test body.
globalThis.__liveRealPath = process.env.PATH;
