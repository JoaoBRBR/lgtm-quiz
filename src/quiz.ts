#!/usr/bin/env node
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ALL_LEVELS,
  DEFAULT_LANGUAGE,
  DEFAULT_QUESTIONS,
  branchDiff,
  currentBranch,
  generateQuestions,
  readStagedDiff,
  repoRoot,
  resolveBranch,
  teach,
  type Level,
  type Question,
  type Teaching,
} from './questions.ts';
import { alreadyPassed, markPassed, runHookCommand, stagedHash } from './hook.ts';
import { getStrings } from './strings.ts';

const HOST = '127.0.0.1';
const DEFAULT_BASE = 'main';
const DEFAULT_PASS_RATE = 0.7;
const DEFAULT_LEVELS: Level[] = [1, 2];
const PERCENT = 100;
const EXIT_DELAY_MS = 300;
const HOOK_TIMEOUT_MS = 30 * 60 * 1000;
const CONFIG_FILE = `${homedir()}/.config/lgtm-quiz/config.json`;
const CACHE_FILE = `${homedir()}/.cache/lgtm-quiz/last-questions.json`;
const PAGE_FILE = new URL('./ui/index.html', import.meta.url);

interface Config {
  base: string;
  passRate: number;
  levels: Level[];
  questions: number;
  language: string;
  validate: boolean;
}

interface Answer {
  choice: number;
  correct: boolean;
  idk: boolean;
  learned: boolean;
  followUpDone: boolean;
}

const USAGE = `Usage: lgtm-quiz [options]
       lgtm-quiz hook on | off | status

Quizzes you on the changes of the current branch against a base branch (default: main).

  --base <branch>    branch to compare against (default: main)
  --staged           quiz only on staged changes
  --levels <list>    question levels, e.g. 1,2,3 (default: 1,2)
  --questions <n>    maximum number of questions (default: ${DEFAULT_QUESTIONS})
  --lang <language>  language of questions and interface, e.g. pt-BR, es, "French" (default: ${DEFAULT_LANGUAGE})
  --no-validate      skip the check that drops guessable questions (faster, cheaper)
  --pass <0-1>       pass rate (default: 0.7)
  --hook             used by the git hook: staged changes, blocks the commit when you fail
  -h, --help         show this help

Personal defaults can be set in ${CONFIG_FILE}, globally or per repository:
  {
    "passRate": 0.8,
    "repos": {
      "/path/to/frontend": {"base": "develop", "levels": [1, 2, 3]},
      "/path/to/backend": {"questions": 8}
    }
  }`;

const answers = new Map<number, Answer>();
const teachings = new Map<number, Teaching>();
const token = randomBytes(16).toString('hex');

function loadConfig(): Config {
  const defaults: Config = {
    base: DEFAULT_BASE,
    passRate: DEFAULT_PASS_RATE,
    levels: DEFAULT_LEVELS,
    questions: DEFAULT_QUESTIONS,
    language: DEFAULT_LANGUAGE,
    validate: true,
  };
  if (!existsSync(CONFIG_FILE)) return defaults;

  const { repos = {}, ...global } = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config> & {
    repos?: Record<string, Partial<Config>>;
  };
  return { ...defaults, ...global, ...repos[currentRepoRoot()] };
}

function currentRepoRoot(): string {
  try {
    return repoRoot(process.cwd());
  } catch {
    return '';
  }
}

function parseLevels(text: string): Level[] {
  const levels = text.split(',').map((l) => Number(l.trim()) as Level);
  if (!levels.length || levels.some((l) => !ALL_LEVELS.includes(l))) {
    throw new Error(`Invalid --levels "${text}". Use numbers from 1 to 3, e.g. 1,2,3.`);
  }
  return levels;
}

function pickDiff(repo: string, config: Config, staged: boolean): string {
  if (staged) return readStagedDiff(repo);

  const base = resolveBranch(repo, config.base);
  if (currentBranch(repo) === config.base) {
    console.log(`You are on "${config.base}" itself, so using staged changes. Use --base to compare elsewhere.`);
    return readStagedDiff(repo);
  }
  console.log(`Comparing ${currentBranch(repo)} against ${base}`);
  return branchDiff(repo, base);
}

async function loadSession(config: Config, staged: boolean): Promise<{ questions: Question[]; diff: string }> {
  if (process.env.LGTM_QUESTIONS) return JSON.parse(readFileSync(process.env.LGTM_QUESTIONS, 'utf8'));

  const repo = repoRoot(process.cwd());
  const diff = pickDiff(repo, config, staged);
  if (!diff.trim()) {
    console.log('No changes to ask about.');
    process.exit(0);
  }

  console.log(`Generating up to ${config.questions} questions (levels ${config.levels.join(', ')})...`);
  const questions = await generateQuestions(diff, {
    levels: config.levels,
    count: config.questions,
    language: config.language,
    validate: config.validate,
  });
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ questions, diff }));
  return { questions, diff };
}

function hunkFor(diff: string, anchor: string): { file: string; text: string } | null {
  const match = /^(.*?):(\d+)/.exec(anchor);
  if (!match) return null;
  const [, file, lineText] = match;
  const line = Number(lineText);

  const section = diff.split(/^diff --git /m).find((s) => s.startsWith(`a/${file} `));
  if (!section) return null;

  const hunks = section.split(/^(?=@@)/m).slice(1);
  const containing = hunks.find((h) => {
    const range = /\+(\d+)(?:,(\d+))?/.exec(h);
    if (!range) return false;
    const start = Number(range[1]);
    const count = range[2] === undefined ? 1 : Number(range[2]);
    return line >= start && line < start + count;
  });
  return { file, text: (containing ?? hunks[0] ?? '').trimEnd() };
}

function publicQuestion(q: Question, diff: string) {
  return {
    id: q.id,
    level: q.level,
    concepts: q.concepts,
    scenario: q.scenario,
    question: q.question,
    options: q.options,
    code: hunkFor(diff, q.hunk),
  };
}

function result(total: number, passRate: number) {
  const all = [...answers.values()];
  const correct = all.filter((a) => a.correct).length;
  const rate = total ? correct / total : 1;
  return {
    correct,
    total,
    percent: Math.round(rate * PERCENT),
    passRate,
    passed: rate >= passRate,
    idk: all.filter((a) => a.idk).length,
    learned: all.filter((a) => a.learned).length,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const { values: flags, positionals } = parseArgs({
  options: {
    base: { type: 'string' },
    staged: { type: 'boolean', default: false },
    levels: { type: 'string' },
    questions: { type: 'string' },
    lang: { type: 'string' },
    'no-validate': { type: 'boolean', default: false },
    pass: { type: 'string' },
    hook: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positionals[0] === 'hook') {
  try {
    console.log(runHookCommand(positionals[1], repoRoot(process.cwd())));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const config = loadConfig();
if (flags.base) config.base = flags.base;
if (flags.levels) config.levels = parseLevels(flags.levels);
if (flags.lang) config.language = flags.lang;
if (flags['no-validate']) config.validate = false;
if (flags.questions) config.questions = Number(flags.questions);
if (!Number.isInteger(config.questions) || config.questions < 1) {
  throw new Error(`Invalid number of questions "${config.questions}". Use a whole number of 1 or more.`);
}
if (flags.pass) config.passRate = Number(flags.pass);
if (process.env.LGTM_PASS_RATE) config.passRate = Number(process.env.LGTM_PASS_RATE);

const hookRepo = flags.hook ? repoRoot(process.cwd()) : '';
let hookHash = '';
if (flags.hook) {
  if (process.env.LGTM_SKIP) process.exit(0);
  hookHash = stagedHash(hookRepo);
  if (alreadyPassed(hookRepo, hookHash)) {
    console.log('lgtm-quiz: you already passed the quiz for these exact changes.');
    process.exit(0);
  }
}

async function prepare() {
  const session = await loadSession(config, flags.staged);
  return { ...session, strings: session.questions.length ? await getStrings(config.language) : {} };
}

// A hook must never lock you out of committing because the tool itself failed.
const { questions, diff, strings } = await prepare().catch((error) => {
  if (!flags.hook) throw error;
  console.error('lgtm-quiz could not run, so the commit is not blocked:', error instanceof Error ? error.message : error);
  process.exit(0);
});
if (!questions.length) {
  console.log('No meaningful changes to ask about. Nothing to prove.');
  process.exit(0);
}
if (flags.hook) {
  console.log('lgtm-quiz: answer the quiz in your browser to continue the commit (Ctrl+C cancels it).');
  setTimeout(() => {
    console.error('lgtm-quiz: timed out waiting for the quiz, commit cancelled.');
    process.exit(1);
  }, HOOK_TIMEOUT_MS).unref();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.searchParams.get('t') !== token || req.headers.host?.split(':')[0] !== HOST) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(PAGE_FILE));
  } else if (req.method === 'GET' && url.pathname === '/api/session') {
    json(res, { questions: questions.map((q) => publicQuestion(q, diff)), passRate: config.passRate, strings });
  } else if (req.method === 'POST' && url.pathname === '/api/answer') {
    const { id, choice } = JSON.parse(await readBody(req));
    const q = questions.find((item) => item.id === id);
    if (!q) return json(res, { error: 'unknown question' }, 404);

    const answer = answers.get(id) ?? {
      choice,
      correct: choice === q.answerIndex,
      idk: false,
      learned: false,
      followUpDone: false,
    };
    answers.set(id, answer);
    json(res, { correct: answer.correct, answerIndex: q.answerIndex, explanation: q.explanation });
  } else if (req.method === 'POST' && url.pathname === '/api/idk') {
    const { id } = JSON.parse(await readBody(req));
    const q = questions.find((item) => item.id === id);
    if (!q) return json(res, { error: 'unknown question' }, 404);
    if (answers.has(id) && !answers.get(id)!.idk) return json(res, { error: 'already answered' }, 409);

    try {
      const teaching = teachings.get(id) ?? (await teach(q, hunkFor(diff, q.hunk)?.text ?? '', config.language));
      teachings.set(id, teaching);
      answers.set(id, { choice: -1, correct: false, idk: true, learned: false, followUpDone: false });
      json(res, { explanation: teaching.explanation, followUp: publicQuestion(teaching.followUp, diff) });
    } catch (error) {
      console.error('Teaching failed:', error);
      json(res, { error: 'could not prepare the explanation' }, 502);
    }
  } else if (req.method === 'POST' && url.pathname === '/api/followup') {
    const { id, choice } = JSON.parse(await readBody(req));
    const teaching = teachings.get(id);
    const answer = answers.get(id);
    if (!teaching || !answer?.idk) return json(res, { error: 'no explanation requested' }, 409);

    if (!answer.followUpDone) {
      answer.followUpDone = true;
      answer.learned = choice === teaching.followUp.answerIndex;
      answer.correct = answer.learned;
    }
    json(res, {
      correct: answer.learned,
      answerIndex: teaching.followUp.answerIndex,
      explanation: teaching.followUp.explanation,
    });
  } else if (req.method === 'GET' && url.pathname === '/api/result') {
    json(res, result(questions.length, config.passRate));
  } else if (req.method === 'POST' && url.pathname === '/api/done') {
    const outcome = result(questions.length, config.passRate);
    if (outcome.passed && flags.hook) markPassed(hookRepo, hookHash);
    json(res, outcome);
    setTimeout(() => process.exit(outcome.passed ? 0 : 1), EXIT_DELAY_MS);
  } else {
    res.writeHead(404).end('Not found');
  }
});

server.listen(0, HOST, () => {
  const { port } = server.address() as { port: number };
  const address = `http://${HOST}:${port}/?t=${token}`;
  console.log(`Quiz ready: ${address}`);
  if (!process.env.LGTM_NO_OPEN) exec(`xdg-open "${address}" || open "${address}"`);
});
