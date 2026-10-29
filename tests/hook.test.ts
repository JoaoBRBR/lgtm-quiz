import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { alreadyPassed, hookOff, hookOn, hookStatus, markPassed, stagedHash } from '../src/hook.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lgtm-hook-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'v1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function makeHuskyRepo(): string {
  const dir = makeRepo();
  mkdirSync(join(dir, '.husky', '_'), { recursive: true });
  writeFileSync(join(dir, '.husky', '_', '.gitignore'), '*\n');
  writeFileSync(join(dir, '.husky', 'commit-msg'), 'echo team\n');
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  git(dir, 'add', '.husky/commit-msg');
  git(dir, 'commit', '-q', '-m', 'husky');
  return dir;
}

test('plain repo: on installs an executable hook, off removes it', () => {
  const repo = makeRepo();
  const file = join(repo, '.git', 'hooks', 'pre-commit');

  assert.match(hookStatus(repo), /OFF/);
  hookOn(repo);
  assert.ok(statSync(file).mode & 0o100, 'hook must be executable');
  assert.match(readFileSync(file, 'utf8'), /lgtm-quiz --staged --hook/);
  assert.match(hookStatus(repo), /ON/);
  assert.equal(git(repo, 'status', '--short'), '');

  hookOff(repo);
  assert.equal(existsSync(file), false);
  assert.match(hookStatus(repo), /OFF/);
});

test('turning the hook on twice is harmless', () => {
  const repo = makeRepo();
  hookOn(repo);
  assert.doesNotThrow(() => hookOn(repo));
});

test('never overwrites a hook that is not ours', () => {
  const repo = makeRepo();
  const file = join(repo, '.git', 'hooks', 'pre-commit');
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(file, '#!/bin/sh\necho mine\n');

  assert.throws(() => hookOn(repo), /won't overwrite/);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.match(hookOff(repo), /not installed/);
  assert.equal(existsSync(file), true, 'off must not delete a foreign hook');
});

test('husky repo: creates .husky/pre-commit, excludes it locally, leaves tracked files alone', () => {
  const repo = makeHuskyRepo();
  hookOn(repo);

  assert.ok(existsSync(join(repo, '.husky', 'pre-commit')));
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.husky\/pre-commit$/m);
  assert.equal(git(repo, 'status', '--short'), '');

  hookOff(repo);
  assert.equal(existsSync(join(repo, '.husky', 'pre-commit')), false);
  assert.doesNotMatch(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /lgtm|husky\/pre-commit/);
  assert.equal(git(repo, 'status', '--short'), '');
});

test('exclude edits keep the user\'s existing lines and blank lines', () => {
  const repo = makeHuskyRepo();
  const exclude = join(repo, '.git', 'info', 'exclude');
  writeFileSync(exclude, '# mine\n\nsecret.txt\n');

  hookOn(repo);
  hookOff(repo);
  assert.equal(readFileSync(exclude, 'utf8'), '# mine\n\nsecret.txt\n');
});

test('a hooks folder outside .git is refused', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'shared-hooks'));
  git(repo, 'config', 'core.hooksPath', 'shared-hooks');
  assert.throws(() => hookOn(repo), /outside \.git/);
});

test('passed marker only matches the exact staged changes', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'a.txt'), 'v2\n');
  git(repo, 'add', 'a.txt');

  const hash = stagedHash(repo);
  assert.equal(alreadyPassed(repo, hash), false);
  markPassed(repo, hash);
  assert.equal(alreadyPassed(repo, hash), true);

  writeFileSync(join(repo, 'a.txt'), 'v3\n');
  git(repo, 'add', 'a.txt');
  assert.equal(alreadyPassed(repo, stagedHash(repo)), false);
});
