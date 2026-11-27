/**
 * Git-diff candidates: the lender returns a unified diff against a base
 * commit instead of a tarball of the whole workspace.
 *
 * Two halves share this module so they cannot drift apart:
 *   - guest scripts (run inside the sandbox, never on the lender host) that
 *     record the base and produce the diff, plus the parser for their output;
 *   - a strict unified-diff reader used for the signed diffstat, the app's
 *     Changes view and `faravan apply`'s safety checks.
 */

/** Marker prefix of the guest scripts; backends and test fakes match on it. */
export const GIT_SCRIPT_MARKER = ': faravan-git-';
export const DIFF_OUTPUT = '.wf-result/changes.diff';
export const isGitCandidateScript = (command) => typeof command === 'string' && command.startsWith(GIT_SCRIPT_MARKER);

// Config on the command line wins over anything the (untrusted) workspace's
// .git/config says: no hooks, no fsmonitor, no external diff drivers.
const GIT = "git -c 'safe.directory=*' -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=faravan -c user.email=faravan@localhost -c commit.gpgsign=false";
const EXCLUDE = "':!.wf-inputs' ':!.wf-outputs' ':!.wf-result'";
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Guest script that fixes the base before the agent runs. `workdir` is '.' for
 * an archive source (initialized as a repository here, base committed with
 * every file) or 'repo' for a pinned Git source (already a clone; base is HEAD).
 * Always exits 0; the outcome is on stdout so a missing git means "tree fallback".
 */
export function baseScript(workdir) {
  const init = workdir === '.'
    ? `[ -e .git ] && { echo FARAVAN_NOGIT=archive_has_git; exit 0; }; ${GIT} init -q . && ${GIT} add -f -A -- . ${EXCLUDE} && ${GIT} commit -q --allow-empty -m 'faravan base' || { echo FARAVAN_NOGIT=git_failed; exit 0; }`
    : '[ -d .git ] || { echo FARAVAN_NOGIT=git_failed; exit 0; }';
  return `${GIT_SCRIPT_MARKER}base; command -v git >/dev/null 2>&1 || { echo FARAVAN_NOGIT=git_unavailable; exit 0; }; ` +
    `cd ${workdir} || { echo FARAVAN_NOGIT=git_failed; exit 0; }; ${init}; ` +
    `echo "FARAVAN_BASE $(${GIT} rev-parse HEAD) $(${GIT} rev-parse 'HEAD^{tree}')"`;
}

/** Guest script that stages everything the agent did and writes the diff against `base`. */
export function diffScript(workdir, base) {
  if (!HEX.test(base)) throw new Error('invalid base commit');
  const out = (workdir === '.' ? '' : '../') + DIFF_OUTPUT;
  return `${GIT_SCRIPT_MARKER}diff; cd ${workdir} && mkdir -p "$(dirname ${out})" && ${GIT} add -u -- . ${EXCLUDE} && ${GIT} ls-files --others --exclude-standard -z -- . ${EXCLUDE} > ${out}.paths && ${GIT} --literal-pathspecs add --pathspec-from-file=${out}.paths --pathspec-file-nul && ` +
    `for output_dir in faravan-output faravan-output; do if [ -d "$output_dir" ] && [ ! -L "$output_dir" ]; then ${GIT} add -f -A -- "$output_dir" || exit; fi; done && ` +
    `${GIT} diff --binary --cached --no-ext-diff --no-textconv --no-color --no-renames --src-prefix=a/ --dst-prefix=b/ ${base} -- . ${EXCLUDE} > ${out}`;
}

/** @returns {{base:string,tree:string}|{unavailable:string}} */
export function parseBaseOutput(stdout) {
  const text = String(stdout ?? '');
  const base = /^FARAVAN_BASE ([0-9a-f]{40,64}) ([0-9a-f]{40,64})$/m.exec(text);
  if (base && HEX.test(base[1]) && HEX.test(base[2])) return { base: base[1], tree: base[2] };
  const no = /^FARAVAN_NOGIT=(git_unavailable|git_failed|archive_has_git)$/m.exec(text);
  return { unavailable: no?.[1] ?? 'git_failed' };
}

// --- unified diff reader ----------------------------------------------------

export class PatchError extends Error {
  constructor(message, code = 'invalid_patch') { super(message); this.name = 'PatchError'; this.code = code; }
}
const bad = (message) => { throw new PatchError(message); };

function unquote(text) {
  if (!text.startsWith('"')) return text;
  if (text.length < 2 || !text.endsWith('"')) bad('Malformed quoted path in patch.');
  const bytes = [];
  const body = text.slice(1, -1);
  const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch)); continue; }
    const next = body[++i];
    if (next === undefined) bad('Malformed quoted path in patch.');
    if (Object.hasOwn(simple, next)) bytes.push(simple[next]);
    else if (/[0-3]/.test(next) && /^[0-7]{2}$/.test(body.slice(i + 1, i + 3))) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bad('Malformed quoted path in patch.');
  }
  return Buffer.from(bytes).toString('utf8');
}
const stripPrefix = (path, prefix) => path.startsWith(prefix) ? path.slice(prefix.length) : bad('Patch path has no a/ or b/ prefix.');

/** Paths of a `diff --git` header: both sides equal (the producer disables renames) or quoted. */
function headerPaths(rest) {
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return [stripPrefix(unquote(quoted[1]), 'a/'), stripPrefix(unquote(quoted[2]), 'b/')];
  const same = rest.length % 2 === 1 ? rest.slice(0, (rest.length - 1) / 2) : null;
  if (same && same.startsWith('a/') && rest === same + ' b/' + same.slice(2)) return [same.slice(2), same.slice(2)];
  const half = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  if (half) return [half[1], half[2]];
  return bad('Unsupported file header in patch.');
}

/**
 * Strict reader for `git diff --binary` output. Throws PatchError on anything
 * it does not understand, so callers never reason about a half-parsed patch.
 * @returns {{files: Array<{path:string,oldPath:string,status:string,oldMode:string|null,newMode:string|null,
 *   binary:boolean,insertions:number,deletions:number,symlinkTarget:string|null}>, insertions:number, deletions:number}}
 */
export function parseUnifiedDiff(input) {
  const text = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input).toString('utf8') : String(input);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files = [];
  let file = null, i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const [oldPath, newPath] = headerPaths(line.slice(11));
      file = { path: newPath, oldPath, status: 'modified', oldMode: null, newMode: null, binary: false,
        insertions: 0, deletions: 0, symlinkTarget: null };
      files.push(file); i++; continue;
    }
    if (!file) bad('Patch does not start with a file header.');
    let m;
    if ((m = /^(old|new) mode ([0-7]{6})$/.exec(line))) { file[m[1] === 'old' ? 'oldMode' : 'newMode'] = m[2]; i++; continue; }
    if ((m = /^(new|deleted) file mode ([0-7]{6})$/.exec(line))) {
      file.status = m[1] === 'new' ? 'added' : 'deleted'; file[m[1] === 'new' ? 'newMode' : 'oldMode'] = m[2]; i++; continue;
    }
    if ((m = /^(rename|copy) (from|to) (.+)$/.exec(line))) {
      const value = unquote(m[3]);
      if (m[2] === 'from') file.oldPath = value; else file.path = value;
      file.status = m[1] === 'rename' ? 'renamed' : 'copied'; i++; continue;
    }
    if (/^(similarity|dissimilarity) index \d+%$/.test(line) || /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(line)) { i++; continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) { i++; continue; }
    if (/^Binary files .* differ$/.test(line)) { file.binary = true; i++; continue; }
    if (line === 'GIT binary patch') {
      file.binary = true; i++;
      while (i < lines.length && !lines[i].startsWith('diff --git ')) i++;
      continue;
    }
    if ((m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line))) {
      let oldLeft = m[1] === undefined ? 1 : Number(m[1]), newLeft = m[2] === undefined ? 1 : Number(m[2]);
      i++;
      while (oldLeft > 0 || newLeft > 0) {
        const body = lines[i++];
        if (body === undefined) bad('Patch ends inside a hunk.');
        const kind = body[0];
        if (kind === ' ' || (body === '' && oldLeft > 0 && newLeft > 0)) { oldLeft--; newLeft--; }
        else if (kind === '-') { oldLeft--; file.deletions++; }
        else if (kind === '+') {
          newLeft--; file.insertions++;
          if (file.newMode === '120000') file.symlinkTarget = body.slice(1);
        } else bad('Unexpected line inside a hunk.');
        if (oldLeft < 0 || newLeft < 0) bad('Hunk is longer than its header says.');
      }
      while (lines[i]?.startsWith('\\')) i++;
      continue;
    }
    bad('Unrecognized line in patch.');
  }
  return {
    files,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

export function diffstat(input) {
  const { files, insertions, deletions } = parseUnifiedDiff(input);
  return { files: files.length, insertions, deletions };
}

/**
 * Why a path from a candidate patch must not be written into a repository, or null.
 * Applies to every path the patch names, at any depth.
 */
export function unsafePatchPath(path) {
  if (typeof path !== 'string' || path === '') return 'empty path';
  if (/[\0\\]/.test(path)) return 'control or backslash character';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'absolute path';
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'path escapes the repository';
    const folded = part.replace(/[. ]+$/, '').toLowerCase();
    if (folded === '.git' || folded === 'git~1') return 'path inside .git';
  }
  return null;
}

/** Whether a symbolic link target can escape the repository on POSIX or Windows. */
export function unsafeSymlinkTarget(target) {
  const normalized = target.replaceAll('\\', '/');
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part=>{const folded=part.replace(/[. ]+$/, '').toLowerCase();return part==='..'||folded==='.git'||folded==='git~1';});
}

/** Reasons the parsed patch is unsafe to apply, from this reader's view of its paths and modes. */
export function patchHazards(parsed) {
  const found = [];
  for (const file of parsed.files) {
    for (const path of new Set([file.path, file.oldPath])) {
      const why = unsafePatchPath(path);
      if (why) found.push(`${path || '(empty)'}: ${why}`);
    }
    if (file.oldMode === '160000' || file.newMode === '160000') found.push(`${file.path}: submodule change`);
    if (file.symlinkTarget !== null && (unsafeSymlinkTarget(file.symlinkTarget))) {
      found.push(`${file.path}: symbolic link points outside the repository`);
    }
  }
  return found;
}
