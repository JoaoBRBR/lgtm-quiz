import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { Question } from './questions.ts';

export interface ConceptStats {
  correct: number;
  wrong: number;
  idk: number;
  confidence: number;
  lastSeen: string;
}

export interface Profile {
  version: 1;
  concepts: Record<string, ConceptStats>;
}

export type Outcome = 'correct' | 'wrong' | 'idk' | 'learned';

const HALF_LIFE_DAYS = 60;
const MS_PER_DAY = 86_400_000;
const MASTERED = 0.8;
const SHAKY = 0.4;
const GAIN: Record<'correct' | 'learned', number> = { correct: 0.3, learned: 0.15 };
const KEPT: Record<'wrong' | 'idk', number> = { wrong: 0.5, idk: 0.3 };
const SAMPLE_MASTERED_CHANCE = 0.15;
const SAMPLED_PRIORITY = 0.5;
const CHANGE_SPECIFIC_FLOOR = 0.5;
const MAX_HINT_MASTERED = 15;
const MAX_HINT_SHAKY = 10;
const MAX_HINT_TAGS = 60;

export function profilePath(): string {
  return process.env.LGTM_PROFILE ?? `${homedir()}/.config/lgtm-quiz/profile.json`;
}

export function emptyProfile(): Profile {
  return { version: 1, concepts: {} };
}

export function normalizeConcept(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/\.{2,}/g, '.');
}

export function loadProfile(file = profilePath()): Profile {
  if (!existsSync(file)) return emptyProfile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Profile;
    return parsed?.version === 1 && parsed.concepts ? parsed : emptyProfile();
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: Profile, file = profilePath()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(profile, null, 2));
}

export function resetProfile(file = profilePath()): void {
  rmSync(file, { force: true });
}

export function hasData(profile: Profile): boolean {
  return Object.keys(profile.concepts).length > 0;
}

export function effectiveConfidence(stats: ConceptStats | undefined, now: Date): number {
  if (!stats) return 0;
  const days = Math.max(0, (now.getTime() - new Date(stats.lastSeen).getTime()) / MS_PER_DAY);
  return stats.confidence * 0.5 ** (days / HALF_LIFE_DAYS);
}

export function recordOutcome(profile: Profile, concepts: string[], outcome: Outcome, now = new Date()): void {
  for (const tag of new Set(concepts.map(normalizeConcept).filter(Boolean))) {
    const stats = profile.concepts[tag] ?? { correct: 0, wrong: 0, idk: 0, confidence: 0, lastSeen: now.toISOString() };
    const current = effectiveConfidence(stats, now);

    if (outcome === 'correct' || outcome === 'learned') {
      stats.confidence = current + (1 - current) * GAIN[outcome];
      stats.correct++;
    } else {
      stats.confidence = current * KEPT[outcome];
      stats[outcome]++;
    }
    stats.lastSeen = now.toISOString();
    profile.concepts[tag] = stats;
  }
}

function conceptConfidence(q: Pick<Question, 'concepts'>, profile: Profile, now: Date): number {
  const tags = q.concepts.map(normalizeConcept).filter(Boolean);
  if (!tags.length) return 0;
  return tags.reduce((sum, tag) => sum + effectiveConfidence(profile.concepts[tag], now), 0) / tags.length;
}

function priority(q: Question, profile: Profile, now: Date, rng: () => number): number {
  const confidence = conceptConfidence(q, profile, now);
  let uncertainty = 1 - confidence;

  if (q.level === 1) {
    if (confidence >= MASTERED && rng() < SAMPLE_MASTERED_CHANCE) uncertainty = SAMPLED_PRIORITY;
    return uncertainty;
  }
  return CHANGE_SPECIFIC_FLOOR + (1 - CHANGE_SPECIFIC_FLOOR) * uncertainty;
}

export interface Selection {
  selected: Question[];
  skippedKnown: number;
}

export function selectQuestions(
  candidates: Question[],
  count: number,
  profile: Profile,
  now = new Date(),
  rng: () => number = Math.random,
): Selection {
  const ranked = candidates
    .map((q, index) => ({ q, index, score: priority(q, profile, now, rng) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = ranked.slice(0, count);
  const skipped = ranked
    .slice(count)
    .filter(({ q }) => q.level === 1 && conceptConfidence(q, profile, now) >= MASTERED).length;

  return { selected: chosen.map(({ q }, id) => ({ ...q, id })), skippedKnown: skipped };
}

export function hintFor(profile: Profile, now = new Date()): string {
  const entries = Object.entries(profile.concepts)
    .map(([tag, stats]) => ({ tag, stats, confidence: effectiveConfidence(stats, now) }))
    .sort((a, b) => b.stats.lastSeen.localeCompare(a.stats.lastSeen));
  if (!entries.length) return '';

  const mastered = entries.filter((e) => e.confidence >= MASTERED).slice(0, MAX_HINT_MASTERED);
  const shaky = entries.filter((e) => e.confidence < SHAKY && e.stats.wrong + e.stats.idk > 0).slice(0, MAX_HINT_SHAKY);
  const tags = entries.slice(0, MAX_HINT_TAGS).map((e) => e.tag);

  const lines = ['Developer profile (use it to choose and tag questions):'];
  if (mastered.length) {
    lines.push(
      `- Already mastered: ${mastered.map((e) => e.tag).join(', ')}. Avoid basic "what does X do" mechanics questions on these, unless this diff uses them in a surprising way.`,
    );
  }
  if (shaky.length) {
    lines.push(`- Still shaky: ${shaky.map((e) => e.tag).join(', ')}. Prefer questions on these whenever the diff touches them.`);
  }
  lines.push(
    `- Concept tags this developer already has: ${tags.join(', ')}. When a concept matches one of them, REUSE that tag exactly instead of inventing a new spelling.`,
  );
  return `\n${lines.join('\n')}\n`;
}

export function describeProfile(profile: Profile, now = new Date()): string {
  const rows = Object.entries(profile.concepts)
    .map(([tag, s]) => ({ tag, s, confidence: effectiveConfidence(s, now) }))
    .sort((a, b) => a.confidence - b.confidence);
  if (!rows.length) return 'No history yet. Take a quiz and your profile will start to fill in.';

  const width = Math.max(...rows.map((r) => r.tag.length), 7);
  const header = `${'concept'.padEnd(width)}  knows   right  wrong  idk  last seen`;
  const lines = rows.map(({ tag, s, confidence }) =>
    `${tag.padEnd(width)}  ${`${Math.round(confidence * 100)}%`.padStart(5)}  ${String(s.correct).padStart(5)}  ${String(s.wrong).padStart(5)}  ${String(s.idk).padStart(3)}  ${s.lastSeen.slice(0, 10)}`,
  );
  return [header, ...lines].join('\n');
}
