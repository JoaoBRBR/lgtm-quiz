import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { ask, parseJson } from "./llm.js";
import { DEFAULT_LANGUAGE } from "./questions.js";
export const EN_STRINGS = {
    progress: 'Question {n} of {total}',
    done: 'Done',
    level: 'Level {n}',
    idk: "I don't know",
    nextQuestion: 'Next question',
    seeResult: 'See result',
    correct: 'Correct',
    notQuite: 'Not quite',
    preparing: 'Preparing an explanation...',
    explainError: 'Could not prepare the explanation ({reason}). Try again.',
    letMeExplain: 'Let me explain',
    checkLearned: 'Now check what you learned',
    correctCount: '{correct} of {total} correct',
    helpSummary: 'Help requested: {idk}, learned: {learned}.',
    passed: 'You reached the {rate}% pass line.',
    failed: 'The pass line is {rate}%. Read the code again and run the quiz for fresh questions.',
    finish: 'Finish',
    closeTab: 'You can close this tab.',
    noCode: 'Code for this question could not be located in the diff.',
};
const PLACEHOLDER = /\{\w+\}/g;
function cacheFile(language) {
    const slug = language.toLowerCase().replace(/[^a-z0-9-]/g, '_');
    return `${homedir()}/.cache/lgtm-quiz/ui-${slug}.json`;
}
function placeholders(text) {
    return (text.match(PLACEHOLDER) ?? []).sort().join(',');
}
function isValidTranslation(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return Object.keys(EN_STRINGS).every((key) => typeof record[key] === 'string' && placeholders(record[key]) === placeholders(EN_STRINGS[key]));
}
export async function getStrings(language) {
    if (language.toLowerCase() === DEFAULT_LANGUAGE)
        return EN_STRINGS;
    const file = cacheFile(language);
    if (existsSync(file)) {
        const cached = JSON.parse(readFileSync(file, 'utf8'));
        if (isValidTranslation(cached))
            return cached;
    }
    try {
        console.log(`Translating the interface to ${language} (first time only)...`);
        const raw = await ask(`Translate the values of this JSON object into ${language}. It is the interface text of a
code-quiz app: keep it short and natural. Keep the keys unchanged and keep every {placeholder} exactly as written.
Reply with ONLY the JSON object, no prose, no code fences.

${JSON.stringify(EN_STRINGS, null, 2)}`);
        const translated = parseJson(raw, '{', '}');
        if (!isValidTranslation(translated))
            throw new Error('translation did not keep all keys and placeholders');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(translated));
        return translated;
    }
    catch (error) {
        console.warn(`Could not translate the interface to ${language}, using English.`, error);
        return EN_STRINGS;
    }
}
