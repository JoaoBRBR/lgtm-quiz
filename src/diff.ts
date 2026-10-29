export interface Hunk {
  text: string;
  score: number;
  index: number;
}

export interface FileDiff {
  file: string;
  header: string;
  hunks: Hunk[];
}

export interface Selection {
  text: string;
  keptHunks: number;
  totalHunks: number;
}

const MAX_HUNK_CHARS = 6_000;
const MAX_HUNKS_PER_FILE = 3;
const MAX_LINES_SCORED = 40;
const LOGIC_LINE_WEIGHT = 2;
const RISKY_PATH_BONUS = 10;
const TEST_FILE_FACTOR = 0.4;

const IGNORED_FILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.(snap|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|map))$|(^|\/)(dist|build|generated|__snapshots__)\//;
const TEST_FILE = /(\.spec\.|\.test\.|__tests__|(^|\/)tests?\/)/;
const RISKY_PATH =
  /(auth|login|token|session|permission|guard|interceptor|security|crypto|password|payment|billing|migration|schema|\.sql|state|store|service|api|http|server|middleware|route)/i;
const TRIVIAL_LINE =
  /^\s*($|\/\/|#|\*|\/\*|--|<!--|import\b|export\b.*\bfrom\b|from\s+\S+\s+import\b|using\b|#include\b|(const|let|var)\s+\w+\s*=\s*require\(|console\.\w+\(|print\(|logger\.\w+\()/;
const LOGIC_LINE =
  /\b(if|else|switch|case|try|catch|throw|await|async|return|while|for|null|undefined|nil|None)\b|&&|\|\||\?\?|\?\.|=>/;

export function parseDiff(diff: string): FileDiff[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .map((section) => {
      const [header, ...hunkTexts] = section.split(/^(?=@@)/m);
      const file = /^diff --git a\/.+? b\/(.+)$/m.exec(header)?.[1] ?? '';
      return {
        file,
        header,
        hunks: hunkTexts.map((text, index) => ({ text, score: scoreHunk(file, text), index })),
      };
    });
}

export function scoreHunk(file: string, hunkText: string): number {
  if (IGNORED_FILE.test(file)) return 0;

  const changed = hunkText
    .split('\n')
    .filter((line) => /^[+-](?![+-])/.test(line))
    .map((line) => line.slice(1))
    .filter((line) => !TRIVIAL_LINE.test(line));
  if (!changed.length) return 0;

  const scored = changed.slice(0, MAX_LINES_SCORED);
  const logic = scored.filter((line) => LOGIC_LINE.test(line)).length;
  const base = scored.length + logic * LOGIC_LINE_WEIGHT + (RISKY_PATH.test(file) ? RISKY_PATH_BONUS : 0);
  return TEST_FILE.test(file) ? base * TEST_FILE_FACTOR : base;
}

function clip(text: string): string {
  if (text.length <= MAX_HUNK_CHARS) return text;
  const cut = text.slice(0, MAX_HUNK_CHARS);
  return cut.slice(0, cut.lastIndexOf('\n') + 1);
}

export function selectHunks(diff: string, budget: number): Selection {
  const files = parseDiff(diff);
  const totalHunks = files.reduce((sum, f) => sum + f.hunks.length, 0);
  if (diff.length <= budget) return { text: diff, keptHunks: totalHunks, totalHunks };

  const candidates = files
    .flatMap((f) => f.hunks.map((h) => ({ file: f.file, hunk: h })))
    .filter((c) => c.hunk.score > 0)
    .sort((a, b) => b.hunk.score - a.hunk.score);

  const chosen = new Map<string, Hunk[]>();
  let used = 0;
  for (const { file, hunk } of candidates) {
    const picked = chosen.get(file) ?? [];
    if (picked.length >= MAX_HUNKS_PER_FILE) continue;

    const section = files.find((f) => f.file === file)!;
    const cost = clip(hunk.text).length + (picked.length ? 0 : section.header.length);
    if (used + cost > budget) continue;

    used += cost;
    chosen.set(file, [...picked, hunk]);
  }

  const text = files
    .filter((f) => chosen.has(f.file))
    .map((f) => f.header + [...chosen.get(f.file)!].sort((a, b) => a.index - b.index).map((h) => clip(h.text)).join(''))
    .join('');
  const keptHunks = [...chosen.values()].reduce((sum, hunks) => sum + hunks.length, 0);
  return { text, keptHunks, totalHunks };
}
