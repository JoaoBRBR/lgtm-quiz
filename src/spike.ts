import { ALL_LEVELS, branchDiff, generateQuestions, resolveBranch } from './questions.ts';

const [repo, base = 'main'] = process.argv.slice(2);
if (!repo) {
  throw new Error('usage: npm run spike -- <repo-path> [base-branch, default: main]');
}

const diff = branchDiff(repo, resolveBranch(repo, base));
if (!diff.trim()) throw new Error('Empty diff');

const questions = await generateQuestions(diff, ALL_LEVELS);
if (!questions.length) console.log('No meaningful hunks: no questions generated.');
questions.forEach((q, i) => {
  console.log(`\n#${i + 1} L${q.level} [${q.concepts.join(', ')}] ${q.hunk}`);
  console.log(`scenario: ${q.scenario}`);
  console.log(q.question);
  q.options.forEach((o, j) => console.log(`  ${'ABCD'[j]}) ${o}${j === q.answerIndex ? '   <-- correct' : ''}`));
  console.log(`  why: ${q.explanation}`);
  if (q.warnings.length) console.log(`  !! ${q.warnings.join('; ')}`);
});
