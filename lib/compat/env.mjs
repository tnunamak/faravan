/** Product environment variables. Empty values count as unset. */
export function compatEnv(name, env = process.env) {
  return env['FARAVAN_' + name] || undefined;
}
