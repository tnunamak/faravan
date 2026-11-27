import { devNull } from 'node:os';

// Mutate only the test process (or a caller-owned env object), never a Git config file.
export function isolateTestGitEnv(env) {
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG(?:$|_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  return env;
}
