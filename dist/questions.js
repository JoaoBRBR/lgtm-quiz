import { execFileSync } from 'node:child_process';
import { selectHunks } from "./diff.js";
import { ask, parseJson } from "./llm.js";
import { balanceOptions, lengthOutlier } from "./balance.js";
import { hasData, hintFor, selectQuestions } from "./profile.js";
import { dropGuessable } from "./validate.js";
export const ALL_LEVELS = [1, 2, 3];
export const DEFAULT_QUESTIONS = 5;
export const DEFAULT_LANGUAGE = 'en';
const MAX_DIFF_CHARS = 60_000;
const CANDIDATE_FACTOR = 2;
const MAX_LENGTH_RATIO = 1.3;
const DISTRACTOR_COUNT = 3;
const LEVEL_DESCRIPTIONS = {
    1: '1 = mechanics: what a construct does in this exact spot, with this exact input.',
    2: '2 = decisions: what a design choice causes in one specific case, compared with the obvious alternative. Not its generic benefit.',
    3: '3 = architecture: how the change fits the wider structure (state, services, layers), what else it affects, and the tradeoff it makes.',
};
const QUESTION_RULES = `Rules:
- "scenario" is ONLY the concrete input or state before the code runs: values, a user action, a configuration, which branch is taken
  ("the list is [A, B, C] and the user drags C up one place"). It must NOT say what the code does, why the change exists, or use the
  names of new fields or flows in a way that reveals the behavior.
- Do not quote or paraphrase the changed code inside the question. Refer to it by function name or location.
- The correct answer must depend on a detail that only this diff reveals (a specific value, condition, order of operations or name).
  A developer who knows the technology but never saw this diff should pick a wrong answer. The distractors are what a reasonable
  developer would EXPECT the code to do.
- Prefer "what happens in this case?" over "why was this added?". Ask "why" only when the answer is a non-obvious fact in the diff.
- No general-knowledge questions.
- Give the correct answer and exactly ${DISTRACTOR_COUNT} distractors separately.
- The correct answer and distractors MUST be similar in length and detail, and written in the same style. Never make the correct answer the most detailed one.
- Each distractor is wrong for a specific, concrete reason that someone who skimmed the code might believe.
- concepts: 1-3 lowercase dotted tags (e.g. rxjs.switchmap, angular.signals).
- "hunk" is "path/of/file:line", using the new-file line number of the code the question is about.`;
const QUESTION_SHAPE = `{"level": number, "concepts": string[], "hunk": "file:line", "scenario": string, "question": string,
 "correct": string, "distractors": string[${DISTRACTOR_COUNT}], "explanation": string}`;
function languageRule(language) {
    if (language.toLowerCase() === DEFAULT_LANGUAGE)
        return '';
    return `
Language: write every human-readable field (scenario, question, correct answer, distractors, explanation) in ${language}.
Keep code, identifiers, file paths and concept tags exactly as they are.
`;
}
function questionsPrompt(levels, count, language, profileHint) {
    return `You are checking whether a developer understands code they are about to commit.
Below is a git diff. Write up to ${count} multiple-choice questions, one per MEANINGFUL hunk.

Skip hunks that change no behavior (log or comment removals, formatting, imports, version bumps, renames
with no logic change). If fewer than ${count} hunks are meaningful, write fewer questions. An empty array is a valid answer.

Only use these levels, and spread the questions across ALL of them whenever the diff has enough meaningful hunks:
${levels.map((l) => `- ${LEVEL_DESCRIPTIONS[l]}`).join('\n')}

${QUESTION_RULES}
${languageRule(language)}${profileHint}
Reply with ONLY a JSON array, no prose, no code fences. Each item:
${QUESTION_SHAPE}

DIFF:
`;
}
function teachingPrompt(q, hunkText, language) {
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
export function readStagedDiff(repo) {
    return git(repo, ['diff', '--cached']);
}
export function branchDiff(repo, base) {
    const mergeBase = git(repo, ['merge-base', base, 'HEAD']).trim();
    return git(repo, ['diff', mergeBase]);
}
export function resolveBranch(repo, base) {
    const candidates = [base, `origin/${base}`];
    const found = candidates.find((c) => {
        try {
            git(repo, ['rev-parse', '--verify', '--quiet', c]);
            return true;
        }
        catch {
            return false;
        }
    });
    if (!found)
        throw new Error(`Branch "${base}" not found. Use --base <branch>.`);
    return found;
}
export function currentBranch(repo) {
    return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}
export function repoRoot(dir) {
    return git(dir, ['rev-parse', '--show-toplevel']).trim();
}
export function git(repo, args) {
    return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
function build(raw, id) {
    const warnings = [];
    if (!raw.scenario?.trim())
        warnings.push('no scenario');
    if (raw.distractors?.length !== DISTRACTOR_COUNT)
        warnings.push('wrong distractor count');
    if (raw.distractors?.length && lengthOutlier(raw) > MAX_LENGTH_RATIO) {
        warnings.push(`correct answer length stands out (${lengthOutlier(raw).toFixed(1)}x outside the wrong answers' range)`);
    }
    const options = shuffle([raw.correct, ...(raw.distractors ?? [])]);
    return { ...raw, id, options, answerIndex: options.indexOf(raw.correct), warnings };
}
export async function generateQuestions(diff, options = {}) {
    const { levels = ALL_LEVELS, count = DEFAULT_QUESTIONS, language = DEFAULT_LANGUAGE, validate = true, profile } = options;
    const adaptive = !!profile && hasData(profile);
    const selection = selectHunks(diff, MAX_DIFF_CHARS);
    if (selection.keptHunks < selection.totalHunks) {
        console.log(`Large change: using the ${selection.keptHunks} riskiest of ${selection.totalHunks} hunks.`);
    }
    const wanted = validate || adaptive ? count * CANDIDATE_FACTOR : count;
    const raw = await ask(questionsPrompt(levels, wanted, language, adaptive ? hintFor(profile) : '') + selection.text);
    const generated = parseJson(raw, '[', ']').slice(0, wanted);
    const candidates = (await Promise.all(generated.map((q) => balanceOptions(q)))).map(build);
    if (!candidates.length)
        return [];
    let pool = candidates;
    if (validate) {
        console.log(`Checking ${candidates.length} questions for guessable ones...`);
        const { kept, dropped } = await dropGuessable(candidates, candidates.length);
        if (dropped)
            console.log(`Dropped ${dropped} question${dropped > 1 ? 's' : ''} that could be answered without the code.`);
        pool = kept;
    }
    const { selected, skippedKnown } = selectQuestions(pool, count, adaptive ? profile : { version: 1, concepts: {} });
    if (skippedKnown)
        console.log(`Skipped ${skippedKnown} basic question${skippedKnown > 1 ? 's' : ''} on things you already know well.`);
    return selected;
}
export async function teach(q, hunkText, language = DEFAULT_LANGUAGE) {
    const raw = parseJson(await ask(teachingPrompt(q, hunkText, language)), '{', '}');
    return { explanation: raw.explanation, followUp: build({ ...raw.followUp, hunk: q.hunk }, q.id) };
}
