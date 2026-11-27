// The coordinator's most recent output lines. A host that never becomes ready keeps them, so the next failure can be diagnosed.
import {writeFileSync} from 'node:fs';

// Sanitize complete lines before retaining them; also sanitize the unfinished
// line on every read. Keep that private fragment intact until the next chunk so
// credentials split across chunks are still recognized as a single value.
function redact(line) {
  return line
    .replace(/(\bAuthorization["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?|\bBearer\s+)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, url => url
      .replace(/(\/\/)[^/?#@]+@/, '$1[redacted]@')
      .replace(/([?&][^=&#]*=)[^&#]*/g, '$1[redacted]')
      .replace(/#.*/, '#[redacted]'))
    .replace(/(\b[\w.-]*(?:token|key|password|passwd|secret|credential|signature|session|cookie)[\w.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\[redacted\]|[^\s"'&,;}\]]+)/gi,
      (_, name, value) => name + (/^["']/.test(value) ? value[0] + '[redacted]' + value[0] : '[redacted]'))
    .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/(?<![a-z0-9+/_-])[a-z0-9+/_-]{40,}={0,2}(?![a-z0-9+/_=-])/gi, '[redacted]');
}

export function createOutputTail(limit = 40) {
  const lines = [];
  let partial = '';
  const keep = line => { lines.push(redact(line)); if (lines.length > limit) lines.shift(); };
  return {
    push(chunk) {
      const parts = (partial + String(chunk)).split('\n');
      partial = parts.pop();
      for (const line of parts) keep(line);
    },
    lines() { return partial ? [...lines, redact(partial)].slice(-limit) : lines.slice(); },
    // Owner-only: the output may name paths and host details.
    writeTo(file) { writeFileSync(file, this.lines().join('\n') + '\n', {mode: 0o600}); },
  };
}
