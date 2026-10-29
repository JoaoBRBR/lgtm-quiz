import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff, scoreHunk, selectHunks } from '../src/diff.ts';

const fileDiff = (file: string, hunks: string[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks.join('')}`;

const hunk = (lines: string[]) => `@@ -1,3 +1,${lines.length} @@\n${lines.join('\n')}\n`;

const authHunk = hunk(['-  return true;', '+  if (!user.token) {', '+    throw new Error("no token");', '+  }', '+  return user.can(permission);']);
const importOnly = hunk(['+import { a } from "./a";', '+import { b } from "./b";']);
const logOnly = hunk(['-  console.log("x");']);

test('hunks with only imports, comments or logs score zero', () => {
  assert.equal(scoreHunk('src/a.ts', importOnly), 0);
  assert.equal(scoreHunk('src/a.ts', logOnly), 0);
  assert.equal(scoreHunk('src/a.ts', hunk(['+// just a comment', '+'])), 0);
});

test('lockfiles and generated files score zero', () => {
  assert.equal(scoreHunk('package-lock.json', authHunk), 0);
  assert.equal(scoreHunk('dist/app.js', authHunk), 0);
});

test('logic in risky paths outranks plain edits and tests', () => {
  const plain = hunk(['+const label = "hello";']);
  assert.ok(scoreHunk('src/auth/guard.ts', authHunk) > scoreHunk('src/ui/label.ts', plain));
  assert.ok(scoreHunk('src/auth/guard.spec.ts', authHunk) < scoreHunk('src/auth/guard.ts', authHunk));
});

test('a diff under the budget is returned untouched', () => {
  const diff = fileDiff('src/a.ts', [authHunk]);
  const selection = selectHunks(diff, diff.length + 1);
  assert.equal(selection.text, diff);
  assert.equal(selection.keptHunks, selection.totalHunks);
});

test('over budget: keeps the risky hunk, drops lockfiles and noise', () => {
  const noise = Array.from({ length: 30 }, (_, i) => `+  "dep-${i}": "1.0.${i}",`);
  const diff =
    fileDiff('package-lock.json', [hunk(noise)]) +
    fileDiff('src/a.ts', [importOnly]) +
    fileDiff('src/auth/guard.ts', [authHunk]);

  const selection = selectHunks(diff, 600);
  assert.match(selection.text, /src\/auth\/guard\.ts/);
  assert.match(selection.text, /throw new Error/);
  assert.doesNotMatch(selection.text, /package-lock/);
  assert.doesNotMatch(selection.text, /import \{ a \}/);
  assert.ok(selection.text.length <= 600);
  assert.equal(selection.keptHunks, 1);
});

test('over budget: no single file can take more than three hunks', () => {
  const many = Array.from({ length: 8 }, (_, i) => hunk([`+  if (x${i}) {`, `+    return ${i};`, '+  }']));
  const diff = fileDiff('src/big.ts', many) + fileDiff('src/other.ts', [authHunk]);

  const selection = selectHunks(diff, 500);
  assert.ok(diff.length > 500);
  const bigHunks = parseDiff(selection.text).find((f) => f.file === 'src/big.ts')?.hunks.length ?? 0;
  assert.ok(bigHunks <= 3);
  assert.match(selection.text, /src\/other\.ts/);
});

test('selected hunks keep their original order inside a file', () => {
  const first = hunk(['+  if (a) {', '+    return 1;', '+  }']);
  const second = hunk(['+  if (b) {', '+    throw new Error("b");', '+  }', '+  await save();']);
  const noise = fileDiff('package-lock.json', [hunk(Array.from({ length: 80 }, (_, i) => `+  "dep-${i}": "1.0.${i}",`))]);
  const diff = fileDiff('src/x.ts', [first, second]) + noise;

  const selection = selectHunks(diff, 600);
  assert.ok(diff.length > 600);
  assert.match(selection.text, /if \(a\)/);
  assert.ok(selection.text.indexOf('if (a)') < selection.text.indexOf('if (b)'));
});
