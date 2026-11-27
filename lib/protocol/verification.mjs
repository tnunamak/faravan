export const CHECK_SKIPPED = Object.freeze({
  workspace:'The fresh check workspace could not start.',
  source:'The returned source could not be prepared for the check.',
  time:'No check time was left.',
});

// P9 evidence: numeric parser output and sandbox file fingerprints, never raw logs.
export const VERIFY_RESERVE_SECONDS = 180;
export function checkSummary(cmd, output) {
  const text = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  let parser = null, counts = '';
  if (/\bpytest\b/.test(cmd)) { parser = 'pytest'; counts = text.split('\n').filter(x=>/={2,}.*\d+ (?:passed|failed|skipped)/.test(x)).at(-1)??''; }
  else if (/^\s*Tests:\s/m.test(text)) { parser = 'jest'; counts = text.match(/^\s*Tests:\s*(.*)$/m)?.[1]??''; }
  else if (/^\s*Test Files\s/m.test(text)) { parser = 'vitest'; counts = text.match(/^\s*Tests\s+(.*)$/m)?.[1]??''; }
  else if (/\bnpm\b/.test(cmd) && /^# pass \d+$/m.test(text) && /^# fail \d+$/m.test(text)) {
    parser = 'npm'; counts = text.match(/^# pass (\d+)$/m)[1]+' passed, '+text.match(/^# fail (\d+)$/m)[1]+' failed';
  }
  const summary = (counts.match(/\b\d+ (?:passed|failed|skipped|pending|todo|xfailed|xpassed|errors?)\b/g)??[]).join(', ').slice(0,120);
  return {parser:summary?parser:null,summary};
}
export function changedTestFiles(before, after) {
  const parse = text => {
    const entries = new Map();
    for (const row of String(text).split('\0').filter(Boolean)) {
      const match = /^([0-9a-f]{64})  \.\/(.+)$/.exec(row);
      if (!match) throw Object.assign(new Error('Invalid sandbox file inventory'),{code:'output_invalid'});
      const path = match[2];
      if (/[\\\x00-\x1f\x7f]/.test(path)||path.length>4096||path.split('/').some(x=>!x||x==='.'||x==='..'))
        throw Object.assign(new Error('Unsafe sandbox file inventory path'),{code:'output_invalid'});
      if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|(^|\/)(package(?:-lock)?\.json|conftest\.py|(?:test_[^/]+|[^/]+_test)\.[^/]+|[^/]*\.(?:test|spec)\.[^/]+|[^/]*config[^/]*|pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg)$/i.test(path))
        entries.set(path,match[1]);
    }
    return entries;
  };
  const a=parse(before),b=parse(after);
  return [...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path)).sort();
}
