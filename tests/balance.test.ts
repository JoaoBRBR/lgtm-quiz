import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceOptions, lengthOutlier, type Options } from '../src/balance.ts';
import type { RawQuestion } from '../src/questions.ts';

const raw = (correct: string, distractors: string[]): RawQuestion => ({
  level: 1,
  concepts: ['x'],
  hunk: 'a.ts:1',
  scenario: 's',
  question: 'q',
  correct,
  distractors,
  explanation: 'e',
});

const tell = raw('It returns the cart unchanged because one flagged item cancels the whole coupon entirely', [
  'It applies the discount to the cart',
  'It throws an error for the flagged item',
  'It skips only the flagged item',
]);

test('lengthOutlier measures how far the correct answer sticks out of the wrong answers\' range', () => {
  assert.ok(lengthOutlier(raw('abc', ['ab', 'abcd', 'abcde'])) <= 1, 'inside the range');
  assert.equal(lengthOutlier(raw('abcdefgh', ['abcd', 'ab', 'a'])), 2, 'longer than all');
  assert.equal(lengthOutlier(raw('ab', ['abcdefgh', 'abcdefgh', 'abcdefgh'])), 4, 'shorter than all');
});

test('rejects a rewrite that overshoots into a too-short correct answer', async () => {
  const overshoot: Options = { correct: 'No.', distractors: tell.distractors };
  assert.equal(await balanceOptions(tell, async () => overshoot), tell);
});

test('rewrites options when the correct answer is clearly the longest', async () => {
  const better: Options = {
    correct: 'It returns the cart unchanged, so no coupon applies at all',
    distractors: [
      'It applies the discount to every item in the cart',
      'It throws an error as soon as it sees the flagged item',
      'It leaves only the flagged item out of the discount',
    ],
  };
  const result = await balanceOptions(tell, async () => better);
  assert.equal(result.correct, better.correct);
  assert.ok(lengthOutlier(result) < lengthOutlier(tell));
});

test('does not call the model when the options are already balanced', async () => {
  const balanced = raw('aaaaaaaaaa', ['bbbbbbbbbb', 'cccccccccc', 'dddddddddd']);
  let called = false;
  const result = await balanceOptions(balanced, async () => ((called = true), null));
  assert.equal(called, false);
  assert.equal(result, balanced);
});

test('keeps the original when the rewrite fails', async () => {
  assert.equal(await balanceOptions(tell, async () => null), tell);
});

test('keeps the original when the rewrite is malformed or not better', async () => {
  const worse: Options = { correct: tell.correct + ' and a lot more words', distractors: tell.distractors };
  assert.equal(await balanceOptions(tell, async () => worse), tell);

  const wrongCount = { correct: 'x', distractors: ['a', 'b'] } as Options;
  assert.equal(await balanceOptions(tell, async () => wrongCount), tell);

  const blank = { correct: 'ok', distractors: ['a', '', 'c'] } as Options;
  assert.equal(await balanceOptions(tell, async () => blank), tell);
});
