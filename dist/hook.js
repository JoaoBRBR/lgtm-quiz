import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { git, readStagedDiff } from "./questions.js";
const MARKER = '# lgtm-quiz hook';
const EXCLUDE_COMMENT = '# lgtm-quiz (local hook)';
const EXECUTABLE = 0o755;
const PASSED_FILE = 'lgtm-quiz-passed';
const HOOK_SCRIPT = `#!/bin/sh
${MARKER} (installed by "lgtm-quiz hook on", removed by "lgtm-quiz hook off")
[ -n "$LGTM_SKIP" ] && exit 0
if ! command -v lgtm-quiz >/dev/null 2>&1; then
  echo "lgtm-quiz: command not found, skipping the quiz" >&2
  exit 0
fi
exec lgtm-quiz --staged --hook
`;
function gitPath(repo, path) {
    return git(repo, ['rev-parse', '--path-format=absolute', '--git-path', path]).trim();
}
function resolveTarget(repo) {
    const hooksDir = gitPath(repo, 'hooks');
    const huskyDir = join(repo, '.husky');
    if (hooksDir === join(huskyDir, '_')) {
        return { file: join(huskyDir, 'pre-commit'), excludeLine: '.husky/pre-commit' };
    }
    const commonDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!resolve(hooksDir).startsWith(commonDir + sep)) {
        throw new Error(`Your hooks folder (${hooksDir}) is outside .git and may be shared with your team, so I won't write there.\n` +
            'Add this line to your own pre-commit setup instead:  lgtm-quiz --staged --hook');
    }
    return { file: join(hooksDir, 'pre-commit'), excludeLine: null };
}
function isOurs(file) {
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
}
function editExclude(repo, line, add) {
    const file = gitPath(repo, 'info/exclude');
    const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const cleaned = original
        .split('\n')
        .filter((l) => l !== line && l !== EXCLUDE_COMMENT)
        .join('\n');
    const base = cleaned.trim() ? cleaned.replace(/\n*$/, '\n') : '';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, add ? `${base}${EXCLUDE_COMMENT}\n${line}\n` : base);
}
export function hookOn(repo) {
    const { file, excludeLine } = resolveTarget(repo);
    if (existsSync(file) && !isOurs(file)) {
        throw new Error(`A pre-commit hook already exists at ${file} and I won't overwrite it.\n` +
            'Add this line to it yourself:  lgtm-quiz --staged --hook');
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, HOOK_SCRIPT);
    chmodSync(file, EXECUTABLE);
    if (excludeLine)
        editExclude(repo, excludeLine, true);
    return `Hook installed: ${file}\nFrom now on "git commit" runs the quiz on what you staged.\n` +
        'Skip once with:  git commit --no-verify   or   LGTM_SKIP=1 git commit\nRemove with:  lgtm-quiz hook off';
}
export function hookOff(repo) {
    const { file, excludeLine } = resolveTarget(repo);
    if (!isOurs(file))
        return 'The lgtm-quiz hook is not installed in this repository.';
    rmSync(file);
    if (excludeLine)
        editExclude(repo, excludeLine, false);
    return `Hook removed: ${file}`;
}
export function hookStatus(repo) {
    const { file } = resolveTarget(repo);
    return isOurs(file) ? `The hook is ON (${file}).` : 'The hook is OFF in this repository.';
}
export function runHookCommand(action, repo) {
    if (action === 'on')
        return hookOn(repo);
    if (action === 'off')
        return hookOff(repo);
    if (action === 'status' || action === undefined)
        return hookStatus(repo);
    throw new Error(`Unknown hook command "${action}". Use: lgtm-quiz hook on | off | status`);
}
function passedFile(repo) {
    return join(git(repo, ['rev-parse', '--absolute-git-dir']).trim(), PASSED_FILE);
}
export function stagedHash(repo) {
    return createHash('sha256').update(readStagedDiff(repo)).digest('hex');
}
export function alreadyPassed(repo, hash) {
    const file = passedFile(repo);
    return existsSync(file) && readFileSync(file, 'utf8').trim() === hash;
}
export function markPassed(repo, hash) {
    writeFileSync(passedFile(repo), hash);
}
