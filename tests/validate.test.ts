import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Question } from '../src/questions.ts';
import { dropGuessable, type BlindAnswer } from '../src/validate.ts';

const question = (id: number): Question => ({
  id,
  level: 1,
  concepts: ['x'],
  hunk: 'a.ts:1',
  scenario: 's',
  question: `q${id}`,
  correct: 'right',
  distractors: ['a', 'b', 'c'],
  explanation: 'e',
  options: ['right', 'a', 'b', 'c'],
  answerIndex: 0,
  warnings: [],
});

const blindBy = (answers: Record<string, BlindAnswer | null>) => async (q: Question) => answers[q.question];

test('drops a question the blind check answers correctly with high confidence', async () => {
  const { kept, dropped } = await dropGuessable(
    [question(0), question(1)],
    5,
    blindBy({ q0: { answer: 0, confidence: 0.95 }, q1: { answer: 2, confidence: 0.9 } }),
  );
  assert.deepEqual(kept.map((q) => q.question), ['q1']);
  assert.equal(dropped, 1);
});

test('keeps a question the blind check got right only with low confidence', async () => {
  const { kept } = await dropGuessable([question(0)], 5, blindBy({ q0: { answer: 0, confidence: 0.5 } }));
  assert.equal(kept.length, 1);
});

test('keeps questions when the blind check fails', async () => {
  const { kept, dropped } = await dropGuessable([question(0)], 5, blindBy({ q0: null }));
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});

test('if everything looks guessable, keeps the least guessable one', async () => {
  const { kept } = await dropGuessable(
    [question(0), question(1), question(2)],
    5,
    blindBy({ q0: { answer: 0, confidence: 0.99 }, q1: { answer: 0, confidence: 0.81 }, q2: { answer: 0, confidence: 0.9 } }),
  );
  assert.deepEqual(kept.map((q) => q.question), ['q1']);
});

test('respects the keep limit and renumbers ids from zero', async () => {
  const { kept } = await dropGuessable(
    [question(5), question(6), question(7)],
    2,
    blindBy({ q5: { answer: 1, confidence: 0.1 }, q6: { answer: 1, confidence: 0.1 }, q7: { answer: 1, confidence: 0.1 } }),
  );
  assert.deepEqual(kept.map((q) => q.id), [0, 1]);
});
