import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  describeProfile,
  effectiveConfidence,
  emptyProfile,
  hintFor,
  loadProfile,
  normalizeConcept,
  recordOutcome,
  saveProfile,
  selectQuestions,
} from '../src/profile.ts';
import type { Question } from '../src/questions.ts';

const DAY_MS = 86_400_000;
const T0 = new Date('2026-01-01T00:00:00Z');
const never = () => 1;
const always = () => 0;

const question = (id: number, level: 1 | 2 | 3, concepts: string[]): Question => ({
  id,
  level,
  concepts,
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

const master = (concept: string, times = 6) => {
  const profile = emptyProfile();
  for (let i = 0; i < times; i++) recordOutcome(profile, [concept], 'correct', T0);
  return profile;
};

test('tags are normalized so spellings do not fragment the profile', () => {
  assert.equal(normalizeConcept('  Array.Map '), 'array.map');
  assert.equal(normalizeConcept('rxjs switch_map'), 'rxjs-switch-map');
  assert.equal(normalizeConcept('angular..signals!'), 'angular.signals');
});

test('correct answers raise confidence, mistakes and IDK lower it', () => {
  const profile = emptyProfile();
  recordOutcome(profile, ['x'], 'correct', T0);
  const afterOne = profile.concepts.x.confidence;
  recordOutcome(profile, ['x'], 'correct', T0);
  assert.ok(profile.concepts.x.confidence > afterOne);

  const high = profile.concepts.x.confidence;
  recordOutcome(profile, ['x'], 'wrong', T0);
  const afterWrong = profile.concepts.x.confidence;
  assert.ok(afterWrong < high);
  recordOutcome(profile, ['x'], 'idk', T0);
  assert.ok(profile.concepts.x.confidence < afterWrong);
  assert.deepEqual([profile.concepts.x.correct, profile.concepts.x.wrong, profile.concepts.x.idk], [2, 1, 1]);
});

test('learning something after IDK gains less than answering it right unaided', () => {
  const learned = emptyProfile();
  const direct = emptyProfile();
  recordOutcome(learned, ['x'], 'learned', T0);
  recordOutcome(direct, ['x'], 'correct', T0);
  assert.ok(learned.concepts.x.confidence < direct.concepts.x.confidence);
});

test('confidence halves after the half-life, so old knowledge is asked again', () => {
  const profile = master('x');
  const now = profile.concepts.x.confidence;
  const later = new Date(T0.getTime() + 60 * DAY_MS);
  assert.ok(Math.abs(effectiveConfidence(profile.concepts.x, later) - now / 2) < 1e-9);
  assert.equal(effectiveConfidence(undefined, T0), 0);
});

test('simulated developer: a mastered basic stops being asked, unseen ones keep coming', () => {
  const profile = master('array.map');
  const candidates = [
    question(0, 1, ['array.map']),
    question(1, 1, ['promise.async']),
    question(2, 1, ['regex.lookahead']),
  ];
  const { selected, skippedKnown } = selectQuestions(candidates, 2, profile, T0, never);
  assert.deepEqual(selected.map((q) => q.concepts[0]), ['promise.async', 'regex.lookahead']);
  assert.equal(skippedKnown, 1);
});

test('questions about this specific change never fade as much as basics', () => {
  const profile = master('array.map');
  const candidates = [question(0, 1, ['array.map']), question(1, 2, ['array.map'])];
  const { selected } = selectQuestions(candidates, 1, profile, T0, never);
  assert.equal(selected[0].level, 2, 'a level 2 question outranks a mastered level 1 basic');
});

test('a mastered basic is still sampled now and then, so a lucky streak cannot hide a topic forever', () => {
  const profile = master('array.map');
  const candidates = [question(0, 1, ['array.map']), question(1, 3, ['unrelated.topic'])];
  const lucky = selectQuestions(candidates, 2, profile, T0, always);
  assert.equal(lucky.selected.length, 2);
  const ranked = selectQuestions([question(0, 1, ['array.map']), question(1, 1, ['array.map'])], 1, profile, T0, always);
  assert.equal(ranked.selected[0].concepts[0], 'array.map');
});

test('with no history every question is equal and the original order is kept', () => {
  const candidates = [question(0, 1, ['a']), question(1, 2, ['b']), question(2, 3, ['c'])];
  const { selected } = selectQuestions(candidates, 2, emptyProfile(), T0, never);
  assert.deepEqual(selected.map((q) => q.question), ['q0', 'q1']);
});

test('selected questions are renumbered from zero', () => {
  const candidates = [question(7, 1, ['a']), question(8, 1, ['b'])];
  assert.deepEqual(selectQuestions(candidates, 2, emptyProfile(), T0, never).selected.map((q) => q.id), [0, 1]);
});

test('the hint names mastered and shaky concepts and asks to reuse tags', () => {
  const profile = master('array.map');
  recordOutcome(profile, ['rxjs.switchmap'], 'idk', T0);
  const hint = hintFor(profile, T0);
  assert.match(hint, /Already mastered: array\.map/);
  assert.match(hint, /Still shaky: rxjs\.switchmap/);
  assert.match(hint, /REUSE that tag/);
  assert.equal(hintFor(emptyProfile(), T0), '');
});

test('profile survives a save and load, and a corrupt file becomes an empty profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lgtm-profile-'));
  const file = join(dir, 'profile.json');
  const profile = master('array.map');
  saveProfile(profile, file);
  assert.deepEqual(loadProfile(file), profile);

  writeFileSync(file, '{not json');
  assert.deepEqual(loadProfile(file), emptyProfile());
  assert.deepEqual(loadProfile(join(dir, 'missing.json')), emptyProfile());
});

test('describeProfile lists the weakest concepts first', () => {
  const profile = master('strong.one');
  recordOutcome(profile, ['weak.one'], 'idk', T0);
  const lines = describeProfile(profile, T0).split('\n');
  assert.match(lines[1], /^weak\.one/);
  assert.match(lines[2], /^strong\.one/);
  assert.match(describeProfile(emptyProfile()), /No history yet/);
});
