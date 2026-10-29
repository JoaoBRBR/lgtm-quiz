import { ask, parseJson } from './llm.ts';
import type { RawQuestion } from './questions.ts';

const BALANCE_RATIO = 1.1;
const DISTRACTOR_COUNT = 3;

export interface Options {
  correct: string;
  distractors: string[];
}

// How far the correct answer sticks out of the length range of the wrong ones, in either direction.
// 1 or less means it sits inside the range; 1.3 means it is 30% longer than the longest or shorter than the shortest.
export function lengthOutlier(q: Pick<RawQuestion, 'correct' | 'distractors'>): number {
  const lengths = q.distractors.map((d) => d.length);
  const correct = Math.max(q.correct.length, 1);
  return Math.max(correct / Math.max(...lengths), Math.min(...lengths) / correct);
}

function rewritePrompt(q: RawQuestion): string {
  return `These answer options for a code-comprehension question give the right answer away because the correct
one is noticeably longer or shorter than the wrong ones. Rewrite the options so all four are about the same length
(within about 15% of each other), in the same style and level of detail.

Rules:
- Do not change which option is correct, and do not change what any option claims.
- Move the odd one toward the others: trim or extend the correct option, and/or adjust the wrong ones with equally specific detail.
- Never make the correct option much shorter than the wrong ones either.
- Every wrong option must stay wrong for the same reason it was wrong before.
- Keep the same language as the originals. Keep code and identifiers exactly as they are.

SCENARIO: ${q.scenario}
QUESTION: ${q.question}
CORRECT: ${q.correct}
WRONG:
${q.distractors.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Reply with ONLY a JSON object, no prose, no code fences:
{"correct": string, "distractors": string[${DISTRACTOR_COUNT}]}`;
}

async function rewriteOptions(q: RawQuestion): Promise<Options | null> {
  try {
    return parseJson<Options>(await ask(rewritePrompt(q)), '{', '}');
  } catch {
    return null;
  }
}

function isBetter(q: RawQuestion, options: Options | null): options is Options {
  return (
    !!options &&
    typeof options.correct === 'string' &&
    options.correct.trim() !== '' &&
    Array.isArray(options.distractors) &&
    options.distractors.length === DISTRACTOR_COUNT &&
    options.distractors.every((d) => typeof d === 'string' && d.trim() !== '') &&
    lengthOutlier(options) < lengthOutlier(q)
  );
}

export async function balanceOptions(
  q: RawQuestion,
  rewrite: (q: RawQuestion) => Promise<Options | null> = rewriteOptions,
): Promise<RawQuestion> {
  if (q.distractors?.length !== DISTRACTOR_COUNT || lengthOutlier(q) <= BALANCE_RATIO) return q;

  const options = await rewrite(q);
  return isBetter(q, options) ? { ...q, correct: options.correct, distractors: options.distractors } : q;
}
