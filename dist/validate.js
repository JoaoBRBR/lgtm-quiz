import { ask, parseJson } from "./llm.js";
const GUESS_CONFIDENCE = 0.8;
function blindPrompt(q) {
    return `You are taking a multiple-choice test about a code change that you CANNOT see.
Answer using only general programming knowledge and clues in the wording. Then rate how confident you are
that your answer is right, from 0 to 1 (1 = certain).

Reply with ONLY a JSON object, no prose: {"answer": <option number>, "confidence": <0 to 1>}

SCENARIO: ${q.scenario}
QUESTION: ${q.question}
${q.options.map((option, i) => `${i}) ${option}`).join('\n')}`;
}
async function blindAnswer(q) {
    try {
        return parseJson(await ask(blindPrompt(q)), '{', '}');
    }
    catch {
        return null;
    }
}
export async function dropGuessable(questions, keep, answerBlind = blindAnswer) {
    const blind = await Promise.all(questions.map(answerBlind));
    const confidence = (i) => (blind[i]?.answer === questions[i].answerIndex ? blind[i].confidence : 0);
    const survivors = questions.filter((_, i) => confidence(i) < GUESS_CONFIDENCE);
    const pool = survivors.length
        ? survivors
        : [...questions].sort((a, b) => confidence(questions.indexOf(a)) - confidence(questions.indexOf(b))).slice(0, 1);
    const kept = pool.slice(0, keep).map((q, id) => ({ ...q, id }));
    return { kept, dropped: questions.length - pool.length };
}
