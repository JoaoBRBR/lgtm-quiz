import { execFileSync, spawn } from 'node:child_process';

export type Level = 1 | 2 | 3;

export interface RawQuestion {
  level: Level;
  concepts: string[];
  hunk: string;
  scenario: string;
  question: string;
  correct: string;
  distractors: string[];
  explanation: string;
}

export interface Question extends RawQuestion {
  id: number;
  options: string[];
  answerIndex: number;
  warnings: string[];
}

export interface Teaching {
  explanation: string;
  followUp: Question;
}

interface RawTeaching {
  explanation: string;
  followUp: RawQuestion;
}

export const ALL_LEVELS: Level[] = [1, 2, 3];

export const DEFAULT_QUESTIONS = 5;
export const DEFAULT_LANGUAGE = 'en';
const MAX_DIFF_CHARS = 60_000;
const MAX_LENGTH_RATIO = 1.3;
const DISTRACTOR_COUNT = 3;

const LEVEL_DESCRIPTIONS: Record<Level, string> = {
  1: '1 = mechanics: what a construct does in this exact spot, with this exact input.',
  2: '2 = decisions: why this approach or structure was chosen over a plausible alternative, and what would go wrong with the alternative.',
  3: '3 = architecture: how the change fits the wider structure (state, services, layers), what else it affects, and the tradeoff it makes.',
};

const QUESTION_RULES = `Rules:
- "scenario" is a concrete input or state taken from the diff ("when the login fails twice in a row"). The question must build on it.
- The question must be unanswerable without reading THIS diff. No general-knowledge questions.
- Give the correct answer and exactly ${DISTRACTOR_COUNT} distractors separately.
- The correct answer and distractors MUST be similar in length and detail, and written in the same style. Never make the correct answer the most detailed one.
- Each distractor is wrong for a specific, concrete reason that someone who skimmed the code might believe.
- concepts: 1-3 lowercase dotted tags (e.g. rxjs.switchmap, angular.signals).
- "hunk" is "path/of/file:line", using the new-file line number of the code the question is about.`;

const QUESTION_SHAPE = `{"level": number, "concepts": string[], "hunk": "file:line", "scenario": string, "question": string,
 "correct": string, "distractors": string[${DISTRACTOR_COUNT}], "explanation": string}`;

function languageRule(language: string): string {
  if (language.toLowerCase() === DEFAULT_LANGUAGE) return '';
  return `
Language: write every human-readable field (scenario, question, correct answer, distractors, explanation) in ${language}.
Keep code, identifiers, file paths and concept tags exactly as they are.
`;
}

function questionsPrompt(levels: Level[], count: number, language: string): string {
  return `You are checking whether a developer understands code they are about to commit.
Below is a git diff. Write up to ${count} multiple-choice questions, one per MEANINGFUL hunk.

Skip hunks that change no behavior (log or comment removals, formatting, imports, version bumps, renames
with no logic change). If fewer than ${count} hunks are meaningful, write fewer questions. An empty array is a valid answer.

Only use these levels, and spread the questions across ALL of them whenever the diff has enough meaningful hunks:
${levels.map((l) => `- ${LEVEL_DESCRIPTIONS[l]}`).join('\n')}

${QUESTION_RULES}
${languageRule(language)}
Reply with ONLY a JSON array, no prose, no code fences. Each item:
${QUESTION_SHAPE}

DIFF:
`;
}

function teachingPrompt(q: Question, hunkText: string, language: string): string {
  return `A developer pressed "I don't know" on this question about code they are about to commit.
Teach them, then check that they learned.

QUESTION: ${q.scenario} ${q.question}
CORRECT ANSWER: ${q.correct}
CONCEPTS: ${q.concepts.join(', ')}
CODE (diff hunk):
${hunkText}

Write:
1. "explanation": 3-6 sentences, plain words for someone who may be a beginner. Explain the underlying concept
   first, then show how it applies to THIS code. No jargon without a one-line definition.
2. "followUp": ONE new multiple-choice question on the same concept, with a DIFFERENT scenario than the one above
   (new input, new state), answerable from the explanation. Same rules as before:
${QUESTION_RULES}
   Use level ${q.level} and the same "hunk" value as the original.
${languageRule(language)}
Reply with ONLY a JSON object, no prose, no code fences:
{"explanation": string, "followUp": ${QUESTION_SHAPE}}`;
}

export function readStagedDiff(repo: string): string {
  return git(repo, ['diff', '--cached']);
}

export function branchDiff(repo: string, base: string): string {
  const mergeBase = git(repo, ['merge-base', base, 'HEAD']).trim();
  return git(repo, ['diff', mergeBase]);
}

export function resolveBranch(repo: string, base: string): string {
  const candidates = [base, `origin/${base}`];
  const found = candidates.find((c) => {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', c]);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`Branch "${base}" not found. Use --base <branch>.`);
  return found;
}

export function currentBranch(repo: string): string {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export function repoRoot(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text']);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `claude exited ${code}`))));
    child.stdin.end(prompt);
  });
}

export function parseJson<T>(raw: string, open: '[' | '{', close: ']' | '}'): T {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end === -1) throw new Error(`No JSON in model output:\n${raw}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function build(raw: RawQuestion, id: number): Question {
  const warnings: string[] = [];
  if (!raw.scenario?.trim()) warnings.push('no scenario');
  if (raw.distractors?.length !== DISTRACTOR_COUNT) warnings.push('wrong distractor count');

  const longestDistractor = Math.max(...(raw.distractors ?? []).map((d) => d.length));
  if (raw.correct.length > longestDistractor * MAX_LENGTH_RATIO) {
    warnings.push(`correct answer is ${(raw.correct.length / longestDistractor).toFixed(1)}x the longest distractor`);
  }

  const options = shuffle([raw.correct, ...(raw.distractors ?? [])]);
  return { ...raw, id, options, answerIndex: options.indexOf(raw.correct), warnings };
}

export async function generateQuestions(
  diff: string,
  levels: Level[] = ALL_LEVELS,
  count = DEFAULT_QUESTIONS,
  language = DEFAULT_LANGUAGE,
): Promise<Question[]> {
  if (diff.length > MAX_DIFF_CHARS) console.warn(`(diff truncated to ${MAX_DIFF_CHARS} chars)`);
  const raw = await ask(questionsPrompt(levels, count, language) + diff.slice(0, MAX_DIFF_CHARS));
  return parseJson<RawQuestion[]>(raw, '[', ']').slice(0, count).map(build);
}

export async function teach(q: Question, hunkText: string, language = DEFAULT_LANGUAGE): Promise<Teaching> {
  const raw = parseJson<RawTeaching>(await ask(teachingPrompt(q, hunkText, language)), '{', '}');
  return { explanation: raw.explanation, followUp: build({ ...raw.followUp, hunk: q.hunk }, q.id) };
}
